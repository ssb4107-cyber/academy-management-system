create index if not exists academy_students_last_sibling_request_idx
  on academy_app.students(last_sibling_request_id)
  where last_sibling_request_id is not null;
