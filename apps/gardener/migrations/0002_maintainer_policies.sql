INSERT OR IGNORE INTO operation_policies (operation_kind, mode) VALUES
  ('branch.create', 'disabled'),
  ('commit.create', 'disabled'),
  ('pull_request.open', 'disabled'),
  ('pull_request.update', 'disabled'),
  ('pull_request.review.submit', 'disabled'),
  ('pull_request.merge', 'disabled');
