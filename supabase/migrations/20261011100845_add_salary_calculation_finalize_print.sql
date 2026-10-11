-- Server-side salary calculation, preview, finalization and immutable statement snapshots.
-- The calculation mirrors the Google salary rules: teacher ownership periods, vacations,
-- February's 30-day basis, actual tuition receipts, special revenue, 3.3% withholding,
-- direct-receipt exclusions and rate/tax-aware adjustments.

alter table academy_app.salary_revisions
  drop constraint if exists salary_revisions_action_check;
alter table academy_app.salary_revisions
  add constraint salary_revisions_action_check check (action in (
    'PAYMENT_ADD','PAYMENT_SUB','FINAL_ADD','FINAL_SUB','MONTH_PAYMENT',
    'HISTORICAL_CREATE','CANCEL','FINALIZE'
  ));

create or replace function academy_app.try_jsonb(p_value text)
returns jsonb language plpgsql immutable security invoker
set search_path=pg_catalog as $$
begin
  return coalesce(p_value::jsonb,'{}'::jsonb);
exception when others then
  return '{}'::jsonb;
end;
$$;

create or replace function academy_app.salary_calculation_rows(p_month date,p_teacher_id text)
returns table(detail jsonb) language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
begin
perform academy_app.salary_admin_email();
return query
with params as (
  select date_trunc('month',p_month)::date month_start,
    (date_trunc('month',p_month)+interval '1 month'-interval '1 day')::date month_end,
    extract(day from date_trunc('month',p_month)+interval '1 month'-interval '1 day')::integer actual_days,
    case when extract(month from p_month)=2 then 30
      else extract(day from date_trunc('month',p_month)+interval '1 month'-interval '1 day')::integer end billing_days
), facts as (
  select f.*,s.student_name,s.grade_label,s.distribution_rate_text,
    coalesce((f.fact_json->'state'->>'status'),f.status) salary_status,
    coalesce((f.fact_json->>'specialOnly')::boolean,false) special_only,
    coalesce((f.fact_json->>'excludedByEarlyExit')::boolean,false) early_exit,
    (to_timestamp((f.fact_json->>'validStart')::numeric/1000) at time zone 'Asia/Seoul')::date valid_start,
    (to_timestamp((f.fact_json->>'validEnd')::numeric/1000) at time zone 'Asia/Seoul')::date valid_end,
    case
      when nullif(regexp_replace(coalesce(s.distribution_rate_text,''),'[^0-9.]','','g'),'') is null then null
      when position('%' in s.distribution_rate_text)>0 or nullif(regexp_replace(s.distribution_rate_text,'[^0-9.]','','g'),'')::numeric>1
        then nullif(regexp_replace(s.distribution_rate_text,'[^0-9.]','','g'),'')::numeric/100
      else nullif(regexp_replace(s.distribution_rate_text,'[^0-9.]','','g'),'')::numeric
    end rate
  from academy_app.monthly_student_facts f
  join academy_app.students s using(student_id)
  where f.snapshot_month=date_trunc('month',p_month)::date and f.in_month
), ownerships as (
  select f.*,
    nullif(o->>'teacherId','') owner_teacher_id,
    coalesce(nullif(o->>'teacher',''),f.teacher_name) owner_name,
    (to_timestamp((o->>'start')::numeric/1000) at time zone 'Asia/Seoul')::date owner_start,
    (to_timestamp((o->>'end')::numeric/1000) at time zone 'Asia/Seoul')::date owner_end
  from facts f cross join lateral jsonb_array_elements(coalesce(f.fact_json->'teacherOwnerships','[]'::jsonb)) o
  where not f.early_exit
), periods as (
  select o.*,greatest(o.valid_start,o.owner_start) period_start,
    least(o.valid_end,o.owner_end) period_end
  from ownerships o
  where o.owner_teacher_id=p_teacher_id
    and greatest(o.valid_start,o.owner_start)<=least(o.valid_end,o.owner_end)
), active_dates as (
  select distinct p.student_id,d.day::date active_date
  from periods p cross join lateral generate_series(p.period_start,p.period_end,interval '1 day') d(day)
  where not exists(select 1 from academy_app.vacation_periods v
    where v.student_id=p.student_id and v.deleted_at is null and d.day::date between v.start_date and v.end_date)
), teacher_days as (
  select p.student_id,count(distinct a.active_date)::integer+max(
    case when extract(month from p_month)=2 and not exists(select 1 from academy_app.vacation_periods v
          where v.student_id=p.student_id and v.deleted_at is null and p.period_end between v.start_date and v.end_date)
      and (p.period_end=(select month_end from params)
        or (p.salary_status='퇴원' and p.exit_date is not null and p.period_end=p.exit_date))
      then greatest(0,30-(select actual_days from params)) else 0 end) active_days,
    min(p.period_start) calc_start,max(p.period_end) calc_end
  from periods p left join active_dates a using(student_id)
  group by p.student_id
), tuition as (
  select student_id,sum(amount)::numeric received
  from academy_app.payments
  where record_status='ACTIVE' and item_type='수강료' and amount>0
    and payment_month=to_char(p_month,'YYYY-MM') group by student_id
), extras as (
  select p.student_id,coalesce(sum(pay.amount),0)::numeric extra_revenue,
    coalesce(jsonb_agg(jsonb_build_object('type',pay.item_type,'amount',pay.amount,
      'date',to_char(pay.pay_date,'YYYY-MM-DD')) order by pay.pay_date,pay.payment_id)
      filter(where pay.payment_id is not null),'[]'::jsonb) extra_items
  from periods p left join academy_app.payments pay on pay.student_id=p.student_id
    and pay.record_status='ACTIVE' and pay.item_type<>'수강료' and pay.amount>0
    and pay.payment_month=to_char(p_month,'YYYY-MM') and pay.pay_date between p.period_start and p.period_end
  group by p.student_id
), rows as (
  select p.student_id,p.student_name,p.grade_label,p.salary_status,p.base_fee,p.billable_fee,
    p.sibling_discount,p.special_only,p.first_date,p.exit_date,p.active_days student_active_days,
    p.billing_days,td.active_days,td.calc_start,td.calc_end,p.rate,
    coalesce(t.received,0) received, t.student_id is not null has_received,
    coalesce(e.extra_revenue,0) extra_revenue,coalesce(e.extra_items,'[]'::jsonb) extra_items,
    case when t.student_id is not null and p.active_days>0
      then round(t.received*td.active_days/p.active_days)
      when p.special_only then 0
      else round(p.billable_fee*td.active_days/nullif(p.billing_days,0)) end tuition_revenue,
    case when t.student_id is not null then '실수납'
      when p.special_only then '특강비만' else '규정금액' end calculation_basis
  from facts p join teacher_days td using(student_id)
  left join tuition t using(student_id) left join extras e using(student_id)
  where p.rate is not null and p.rate between 0 and 1
), final_rows as (
  select r.*,round((r.tuition_revenue+r.extra_revenue)*r.rate) calculated_share
  from rows r where r.active_days>0 or r.extra_revenue>0
)
select jsonb_build_object(
  'studentId',student_id,'name',student_name,'grade',grade_label,'status',salary_status,
  'fee',billable_fee,'rate',rate,'monthDays',billing_days,'activeDays',active_days,
  'studentActiveDays',student_active_days,'dateRange',to_char(calc_start,'MM.DD')||'~'||to_char(calc_end,'MM.DD'),
  'exitDate',coalesce(to_char(exit_date,'YYYY.MM.DD'),'-'),'calculatedShare',calculated_share,
  'proratedRevenue',tuition_revenue,'specialRevenue',extra_revenue,
  'totalRowRevenue',tuition_revenue+extra_revenue,'specialOnly',special_only,
  'calculationBasis',calculation_basis,'extraItems',extra_items
) as detail from final_rows order by student_name,student_id;
end;
$$;

create or replace function academy_app.salary_preview_for_teacher(
  p_month date,p_teacher_id text,p_exclusions jsonb default '[]'::jsonb,
  p_adjustments jsonb default '[]'::jsonb
)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='5s' as $$
declare v_teacher academy_app.teachers%rowtype;v_rows jsonb;v_included jsonb;v_excluded jsonb;
  v_exclusion_count integer;v_total_revenue numeric;v_share numeric;v_tax numeric;v_base numeric;
  v_rate numeric;v_adjustment numeric:=0;v_final numeric;v_adjustments jsonb:='[]'::jsonb;
  v_item jsonb;v_origin numeric;v_amount numeric;v_signed numeric;v_token text;
begin
  perform academy_app.salary_admin_email();
  select * into v_teacher from academy_app.teachers where teacher_id=p_teacher_id;
  if not found or not v_teacher.salary_target then
    raise exception using errcode='22023',message='급여 정산 대상 원장을 선택해주세요.';
  end if;
  if jsonb_typeof(coalesce(p_exclusions,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_exclusions,'[]'::jsonb))>100 then
    raise exception using errcode='22023',message='직접수령 제외 목록을 확인해주세요.';
  end if;
  if jsonb_typeof(coalesce(p_adjustments,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_adjustments,'[]'::jsonb))>30 then
    raise exception using errcode='22023',message='급여 조정 목록을 확인해주세요.';
  end if;
  select coalesce(jsonb_agg(detail),'[]'::jsonb) into v_rows
    from academy_app.salary_calculation_rows(p_month,p_teacher_id);
  select count(*) into v_exclusion_count from (
    select distinct nullif(btrim(value->>'studentId'),'') student_id
    from jsonb_array_elements(coalesce(p_exclusions,'[]'::jsonb)) value
  )q where student_id is not null;
  if v_exclusion_count<>jsonb_array_length(coalesce(p_exclusions,'[]'::jsonb)) then
    raise exception using errcode='22023',message='직접수령 제외 학생이 비어 있거나 중복되었습니다.';
  end if;
  select coalesce(jsonb_agg(r) filter(where not excluded),'[]'::jsonb),
    coalesce(jsonb_agg(r) filter(where excluded),'[]'::jsonb),
    coalesce(sum((r->>'totalRowRevenue')::numeric) filter(where not excluded),0),
    coalesce(sum((r->>'calculatedShare')::numeric) filter(where not excluded),0),
    coalesce(max((r->>'rate')::numeric),coalesce(v_teacher.default_distribution_rate,60)/100)
  into v_included,v_excluded,v_total_revenue,v_share,v_rate
  from (select value r,exists(select 1 from jsonb_array_elements(coalesce(p_exclusions,'[]'::jsonb)) x
    where x->>'studentId'=value->>'studentId') excluded from jsonb_array_elements(v_rows)value)q;
  if jsonb_array_length(v_excluded)<>v_exclusion_count then
    raise exception using errcode='22023',message='현재 계산에서 찾을 수 없는 직접수령 제외 학생이 있습니다.';
  end if;
  v_tax:=trunc(v_share*0.033);v_base:=v_share-v_tax;
  for v_item in select value from jsonb_array_elements(coalesce(p_adjustments,'[]'::jsonb)) loop
    v_origin:=round(coalesce(nullif(v_item->>'originAmount','')::numeric,0));
    if v_origin<0 or v_origin>100000000 then raise exception using errcode='22023',message='조정 금액 범위를 확인해주세요.'; end if;
    v_amount:=v_origin;
    if coalesce((v_item->>'isRate')::boolean,false) then v_amount:=round(v_amount*v_rate); end if;
    if coalesce((v_item->>'isTax')::boolean,false) then v_amount:=v_amount-trunc(v_amount*0.033); end if;
    v_signed:=case when coalesce(v_item->>'type','') like 'SUB%' then -v_amount else v_amount end;
    v_adjustment:=v_adjustment+v_signed;
    v_adjustments:=v_adjustments||jsonb_build_array(jsonb_build_object('type',coalesce(v_item->>'type','ADD'),
      'typeText',coalesce(nullif(v_item->>'typeText',''),'조정'),'originAmount',v_origin,'finalAmount',v_signed,
      'note',left(coalesce(v_item->>'note',''),500),'isRate',coalesce((v_item->>'isRate')::boolean,false),
      'isTax',coalesce((v_item->>'isTax')::boolean,false),'representativeRate',v_rate));
  end loop;
  v_final:=round(v_base+v_adjustment);
  if v_final<0 then raise exception using errcode='22023',message='조정 후 확정 급여는 0원보다 작을 수 없습니다.'; end if;
  v_token:=md5(jsonb_build_object('schemaVersion',3,'month',to_char(p_month,'YYYY-MM'),'teacherId',p_teacher_id,
    'list',v_included,'excluded',v_excluded,'adjustments',v_adjustments,'finalAmount',v_final)::text);
  return jsonb_build_object('schemaVersion',3,'month',to_char(p_month,'YYYY-MM'),
    'teacher',jsonb_build_object('id',v_teacher.teacher_id,'name',v_teacher.teacher_name),
    'data',jsonb_build_object('list',v_included,'summary',jsonb_build_object(
      'totalRevenue',v_total_revenue,'teacherShare',v_share,'tax',v_tax,'finalPay',v_base,
      'actualReceivedCount',(select count(*) from jsonb_array_elements(v_included)x where x->>'calculationBasis'='실수납'),
      'theoreticalCount',(select count(*) from jsonb_array_elements(v_included)x where x->>'calculationBasis'='규정금액'),
      'specialOnlyCount',(select count(*) from jsonb_array_elements(v_included)x where x->>'calculationBasis'='특강비만'),
      'directReceiptExcludedCount',v_exclusion_count)),
    'excluded',v_excluded,'exclusions',coalesce(p_exclusions,'[]'::jsonb),'adjustments',v_adjustments,
    'representativeRate',v_rate,'baseAmount',v_base,'adjustmentAmount',v_adjustment,
    'finalAmount',v_final,'previewToken',v_token);
end;
$$;

create or replace function public.preview_salary_month(p_month text,p_options jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='8s' as $$
declare v_email text:=academy_app.salary_admin_email();v_month date;v_result jsonb;
begin
  if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception using errcode='22023',message='조회 월을 선택해주세요.'; end if;
  if jsonb_typeof(coalesce(p_options,'{}'::jsonb))<>'object' then raise exception using errcode='22023',message='급여 계산 옵션을 확인해주세요.'; end if;
  v_month:=to_date(p_month||'-01','YYYY-MM-DD');
  select jsonb_build_object('month',p_month,'teachers',coalesce(jsonb_agg(
    academy_app.salary_preview_for_teacher(v_month,t.teacher_id,
      coalesce((select x->'exclusions' from jsonb_array_elements(coalesce(p_options->'teachers','[]'::jsonb))x where x->>'teacherId'=t.teacher_id limit 1),'[]'::jsonb),
      coalesce((select x->'adjustments' from jsonb_array_elements(coalesce(p_options->'teachers','[]'::jsonb))x where x->>'teacherId'=t.teacher_id limit 1),'[]'::jsonb))
    order by t.teacher_name),'[]'::jsonb),'generatedAt',to_char(now() at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'))
  into v_result from academy_app.teachers t where t.salary_target=true;
  return v_result;
end;
$$;

create or replace function public.finalize_salary_month(p_month text,p_items jsonb,p_request_id uuid)
returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog set statement_timeout='12s' as $$
declare v_email text:=academy_app.salary_admin_email();v_month date;v_hash text;v_existing academy_app.salary_operation_requests%rowtype;
  v_item jsonb;v_preview jsonb;v_teacher_id text;v_id text;v_result jsonb;v_saved jsonb:='[]'::jsonb;
  v_entry jsonb;v_count integer:=0;v_total numeric:=0;
begin
  if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception using errcode='22023',message='확정 월을 선택해주세요.'; end if;
  if p_request_id is null then raise exception using errcode='22023',message='중복 방지 요청 ID가 필요합니다.'; end if;
  if jsonb_typeof(coalesce(p_items,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_items,'[]'::jsonb)) not between 1 and 30 then
    raise exception using errcode='22023',message='확정할 원장을 1명 이상 선택해주세요.';
  end if;
  v_hash:=md5(concat_ws('|',p_month,p_items::text));
  select * into v_existing from academy_app.salary_operation_requests where request_id=p_request_id;
  if found then
    if v_existing.request_hash<>v_hash then raise exception using errcode='22023',message='같은 요청 ID에 다른 입력값을 사용할 수 없습니다.'; end if;
    return v_existing.result_json;
  end if;
  v_month:=to_date(p_month||'-01','YYYY-MM-DD');
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_teacher_id:=nullif(btrim(v_item->>'teacherId'),'');
    if v_teacher_id is null then raise exception using errcode='22023',message='확정할 원장 정보가 없습니다.'; end if;
    if exists(select 1 from academy_app.salary_settlements where settlement_month=v_month and teacher_id=v_teacher_id and settlement_status<>'취소') then
      raise exception using errcode='23505',message='이미 확정된 원장이 포함되어 있습니다.';
    end if;
    v_preview:=academy_app.salary_preview_for_teacher(v_month,v_teacher_id,
      coalesce(v_item->'exclusions','[]'::jsonb),coalesce(v_item->'adjustments','[]'::jsonb));
    if nullif(v_item->>'previewToken','') is null or v_item->>'previewToken'<>v_preview->>'previewToken'
      or nullif(v_item->>'expectedFinalAmount','')::numeric<>(v_preview->>'finalAmount')::numeric then
      raise exception using errcode='40001',message='미리보기 이후 급여 원본 또는 금액이 변경되었습니다. 다시 계산해주세요.';
    end if;
    v_id:='SAL-'||gen_random_uuid()::text;
    insert into academy_app.salary_settlements(settlement_id,settlement_month,teacher_id,teacher_name,
      settlement_status,base_amount,adjustment_amount,final_amount,paid_amount,balance_amount,
      source_type,memo,created_at,updated_at,confirmed_at,confirmed_by,source_system,version,last_request_id)
    values(v_id,v_month,v_teacher_id,v_preview->'teacher'->>'name','미지급',(v_preview->>'baseAmount')::numeric,
      (v_preview->>'adjustmentAmount')::numeric,(v_preview->>'finalAmount')::numeric,0,(v_preview->>'finalAmount')::numeric,
      '자동계산','',now(),now(),now(),v_email,'SUPABASE',1,p_request_id);
    insert into academy_app.salary_entries(entry_id,settlement_id,entry_type,amount,entry_date,memo,created_at,created_by,entry_status,reference_id,details_json,source_system)
    values('SLE-'||gen_random_uuid()::text,v_id,'정산요약',(v_preview->>'finalAmount')::numeric,current_date,'확정 시점 요약',now(),v_email,'완료',v_teacher_id,
      jsonb_build_object('schemaVersion',3,'previewToken',v_preview->>'previewToken','summary',v_preview->'data'->'summary'),'SUPABASE');
    for v_entry in select value from jsonb_array_elements(v_preview->'data'->'list') loop
      insert into academy_app.salary_entries(entry_id,settlement_id,entry_type,amount,entry_date,memo,created_at,created_by,entry_status,reference_id,details_json,source_system)
      values('SLE-'||gen_random_uuid()::text,v_id,'계산근거',(v_entry->>'calculatedShare')::numeric,current_date,v_entry->>'name',now(),v_email,'완료',v_entry->>'studentId',v_entry,'SUPABASE');
    end loop;
    for v_entry in select value from jsonb_array_elements(v_preview->'excluded') loop
      insert into academy_app.salary_entries(entry_id,settlement_id,entry_type,amount,entry_date,memo,created_at,created_by,entry_status,reference_id,details_json,source_system)
      values('SLE-'||gen_random_uuid()::text,v_id,'직접수령제외',-abs((v_entry->>'calculatedShare')::numeric),current_date,
        coalesce((select x->>'reason' from jsonb_array_elements(v_preview->'exclusions')x where x->>'studentId'=v_entry->>'studentId' limit 1),'원장 직접 현금 수령(선입금)'),
        now(),v_email,'완료',v_entry->>'studentId',v_entry,'SUPABASE');
    end loop;
    for v_entry in select value from jsonb_array_elements(v_preview->'adjustments') loop
      insert into academy_app.salary_entries(entry_id,settlement_id,entry_type,amount,entry_date,memo,created_at,created_by,entry_status,reference_id,details_json,source_system)
      values('SLE-'||gen_random_uuid()::text,v_id,case when (v_entry->>'finalAmount')::numeric<0 then '조정공제' else '조정추가' end,
        (v_entry->>'finalAmount')::numeric,current_date,left(coalesce(v_entry->>'note',''),500),now(),v_email,'완료','',v_entry,'SUPABASE');
    end loop;
    insert into academy_app.salary_revisions(settlement_id,action,before_data,after_data,memo,actor_email,request_id)
    values(v_id,'FINALIZE',null,jsonb_build_object('status','미지급','finalAmount',(v_preview->>'finalAmount')::numeric,'version',1),p_month||' 자동 계산 확정',v_email,p_request_id);
    v_saved:=v_saved||jsonb_build_array(jsonb_build_object('settlementId',v_id,'teacherId',v_teacher_id,
      'teacherName',v_preview->'teacher'->>'name','finalAmount',(v_preview->>'finalAmount')::numeric,'version',1));
    v_count:=v_count+1;v_total:=v_total+(v_preview->>'finalAmount')::numeric;
  end loop;
  v_result:=jsonb_build_object('month',p_month,'count',v_count,'totalFinalAmount',v_total,'settlements',v_saved,'replayed',false);
  insert into academy_app.salary_operation_requests values(p_request_id,'FINALIZE',v_hash,v_result,v_email,now());
  return v_result;
end;
$$;

create or replace function public.get_salary_statements(p_month text)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set statement_timeout='8s' as $$
declare v_email text:=academy_app.salary_admin_email();v_month date;v_result jsonb;
begin
  if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception using errcode='22023',message='출력 월을 선택해주세요.'; end if;
  v_month:=to_date(p_month||'-01','YYYY-MM-DD');
  select jsonb_build_object('month',p_month,'statements',coalesce(jsonb_agg(jsonb_build_object(
    'settlement',jsonb_build_object('id',s.settlement_id,'teacherId',s.teacher_id,'teacherName',s.teacher_name,
      'status',s.settlement_status,'baseAmount',s.base_amount,'adjustmentAmount',s.adjustment_amount,
      'finalAmount',s.final_amount,'paidAmount',s.paid_amount,'balanceAmount',s.balance_amount,
      'confirmedAt',to_char(s.confirmed_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI'),'confirmedBy',s.confirmed_by),
    'data',jsonb_build_object('list',coalesce((select jsonb_agg(case when e.source_system='GOOGLE_SNAPSHOT'
          then academy_app.try_jsonb(e.details_json->>'raw') else e.details_json end order by e.memo,e.entry_id)
        from academy_app.salary_entries e where e.settlement_id=s.settlement_id and e.entry_status<>'취소'
          and e.entry_type in ('계산근거','직접수령제외')),'[]'::jsonb),
      'summary',coalesce((select case when e.source_system='GOOGLE_SNAPSHOT'
          then academy_app.try_jsonb(e.details_json->>'raw')->'summary' else e.details_json->'summary' end
        from academy_app.salary_entries e where e.settlement_id=s.settlement_id and e.entry_status<>'취소' and e.entry_type='정산요약'
        order by e.created_at desc limit 1),jsonb_build_object('finalPay',s.base_amount)),
      'adjustments',coalesce((select jsonb_agg(case when e.source_system='GOOGLE_SNAPSHOT'
          then academy_app.try_jsonb(e.details_json->>'raw') else e.details_json end order by e.created_at,e.entry_id)
        from academy_app.salary_entries e where e.settlement_id=s.settlement_id and e.entry_status<>'취소'
          and e.entry_type in ('조정추가','조정공제','확정액추가보정','확정액공제보정')),'[]'::jsonb))
  ) order by s.teacher_name),'[]'::jsonb)) into v_result
  from academy_app.salary_settlements s where s.settlement_month=v_month and s.settlement_status<>'취소';
  return v_result;
end;
$$;

revoke all on function academy_app.try_jsonb(text) from public,anon;
revoke all on function academy_app.salary_calculation_rows(date,text) from public,anon;
revoke all on function academy_app.salary_preview_for_teacher(date,text,jsonb,jsonb) from public,anon;
revoke all on function public.preview_salary_month(text,jsonb) from public,anon;
revoke all on function public.finalize_salary_month(text,jsonb,uuid) from public,anon;
revoke all on function public.get_salary_statements(text) from public,anon;
grant execute on function academy_app.try_jsonb(text) to authenticated;
grant execute on function academy_app.salary_calculation_rows(date,text) to authenticated;
grant execute on function academy_app.salary_preview_for_teacher(date,text,jsonb,jsonb) to authenticated;
grant execute on function public.preview_salary_month(text,jsonb) to authenticated;
grant execute on function public.finalize_salary_month(text,jsonb,uuid) to authenticated;
grant execute on function public.get_salary_statements(text) to authenticated;

comment on function public.preview_salary_month(text,jsonb) is 'Fresh server-side salary preview with exclusions and adjustments.';
comment on function public.finalize_salary_month(text,jsonb,uuid) is 'All-or-nothing idempotent salary finalization from a verified preview.';
