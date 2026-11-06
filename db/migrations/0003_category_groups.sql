-- Admin-defined groups that merge Toast labels for reporting, e.g. the
-- sales categories "Draft", "Draft Beer" and "HH Draft" -> "Beer".
-- Applied when the dashboard reads data, so history regroups instantly and
-- stored Toast data is never changed.
CREATE TABLE category_groups (
  dimension    TEXT NOT NULL,   -- 'sales_category' | 'dining_option' | 'revenue_center'
  source_label TEXT NOT NULL,   -- the label as it comes from Toast
  group_name   TEXT NOT NULL,
  PRIMARY KEY (dimension, source_label)
) WITHOUT ROWID;
