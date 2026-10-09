do $$
declare
  v_oid regprocedure:='public.submit_sibling_request(text,text[],text,numeric,date,text,uuid)'::regprocedure;
  v_definition text;
begin
  select pg_get_functiondef(v_oid) into v_definition;
  if strpos(v_definition,'jsonb_object_length(v_versions)')>0 then
    execute replace(
      v_definition,
      'jsonb_object_length(v_versions)',
      '(select count(*) from jsonb_object_keys(v_versions))'
    );
  end if;
end;
$$;
