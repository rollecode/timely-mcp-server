### 2.1.0: 2026-08-28

* Fix `timely_me` and `timely_account` returning 404
* Send `hour_rate`, so project rates actually save
* Accept `hours` and `fees` as `budget_type`
* Require `rate_type` when creating a project
* Fail loudly when Timely drops a written field
* Filter entries by user, project, label and billing state
* Use `per_page` for entry paging
* Add `timely_set_events_billable` for bulk changes
* Add `timely_project_rates` and `timely_update_user`
* Add `timely_unrated_work` to find unpriced hours
* Add `timely_user_capacities` and `timely_delete_project`
* Report revenue, internal cost and invoiced hours
* Compact time entries instead of embedding projects

### 2.0.0: 2026-08-26

* Cover clients, teams, roles, reports and webhooks
* Add planned work and account tools
* Patch semantics on every update
* Summarise reports instead of dumping entries
* Serve over HTTP behind an OAuth 2.1 login
* Brand the sign-in page with Timely colours
* Split the API client out of the server

### 1.0.0: 2026-03-06

* Initial release
* OAuth authentication with auto token refresh
* Tools for time entries, projects, users, tasks, and labels
* Label support in time entries via `label_ids`
