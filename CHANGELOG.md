### Unreleased

* Default `timely_list_events` to the authenticated user's own entries so admins no longer get the whole account by default
* Add `all_users` option to `timely_list_events` for the account-wide admin view

### 1.0.1: 2026-05-22

* Fix account ID auto-detection during OAuth setup by using `/1.1/accounts` instead of the non-existent `/1.1/me`

### 1.0.0: 2026-03-06

* Initial release
* OAuth authentication with auto token refresh
* Tools for time entries, projects, users, tasks, and labels
* Label support in time entries via `label_ids`
