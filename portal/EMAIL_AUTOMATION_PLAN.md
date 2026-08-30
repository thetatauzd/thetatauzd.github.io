# Email Automation Feature Plan

## 1. Goal

Build a simple, authenticated email automation feature for the chapter portal that allows an admin to:

- choose a reusable email template or upload a custom one
- upload a CSV/Excel file with recipient data
- map template variables to spreadsheet columns
- preview the generated email before sending
- send a test email to a test recipient
- send to all valid rows in the dataset
- skip invalid records without failing the entire send batch

The feature must support any email provider that accepts valid authentication and allows sending mail, instead of being locked to Gmail.

---

## 2. Core Design Principle

This feature should be provider-agnostic.

The app should not assume Gmail-specific behavior. Instead, it should support a configured mail provider behind a generic email delivery layer.

Examples of supported providers:

- Gmail
- Outlook / Microsoft 365
- SMTP relay
- SendGrid
- Mailgun
- Resend
- any other provider with supported SMTP or API integration

The app should only care that the selected provider can accept:

- server endpoint
- credentials
- sender identity
- send request

---

## 3. Auth and Access Model

### Access Rules

- Only authenticated and authorized portal users can access the feature
- The feature is admin-only or restricted to permitted chapter roles
- The browser should never store the sending password or API secret
- The actual email send should happen from the backend/service layer, not directly from client-side JavaScript

### Why auth matters

The user must be signed in before they can:

- access the page
- create or edit templates
- upload recipient lists
- trigger a send

This prevents arbitrary use of the tool and ensures outbound email is only performed by authorized admins.

---

## 4. Email Provider Configuration Model

The backend should support multiple sender contexts instead of locking the feature to a single Gmail-style account.

The system should allow:

- chapter email senders
- personal or alternate organizational senders
- multiple SMTP profiles for different identities

This is still compatible with a simple SMTP design, assuming each sender profile can authenticate and send mail through its own account or relay.

### Provider config fields

Each sender profile should include:

- profile name
- provider type (SMTP)
- host
- port
- secure connection type (SSL, TLS, STARTTLS, or none)
- username
- password or app token
- from address
- optional reply-to address
- optional default subject
- optional notes or label

### Shared vs personal config

The system can support both shared chapter mail and personal/alternate email senders.

Examples:

- Chapter mailbox: chapter@domain.com
- Personal officer mailbox: president@gmail.com
- Alternate chapter account: rush@domain.com

Shared chapter config:

- host
- port
- secure connection type
- username
- from address

Personal or alternate sender config:

- same SMTP fields, but tied to that specific account identity
- may be created by an admin and stored in a secure backend config store

The secret portion remains sensitive in all cases:

- password or app token

This should never be stored in the front-end or exposed in browser code. It should live in a secure backend/admin-controlled configuration store.

### Recommended v1 pattern

Support multiple SMTP sender profiles, each with its own configured credentials and from address.

This allows:

- chapter-wide shared sending
- personal officer sending when necessary
- alternate chapter identities without changing the logic of the feature

The feature should present a selector for which sender profile to use before sending.

---

## 5. Template System

The tool should support both reusable starter templates and custom uploaded templates.

### Starter template library

The system should ship with a set of standard chapter templates that users can select and begin editing instead of starting from a blank page.

Examples:

- Rush invitation
- Recruitment follow-up
- Chapter event reminder
- Officer announcement
- Thank-you note
- General chapter update
- Deadline reminder
- RSVP follow-up

### Template structure

Each template should include:

- template name
- template type/category
- subject line
- body text
- placeholder variables such as:
  - {{first_name}}
  - {{last_name}}
  - {{email}}
  - {{chapter}}
  - {{event_name}}
  - {{date}}
  - {{deadline}}

### Template behavior

- choose a starter template
- optionally edit the template text
- optionally upload a custom .txt template
- stop the user from sending if required variables are missing

This gives chapter admins a quicker way to standardize communication without re-creating the same email structure each time.

---

## 6. Recipient Data Input

The system should accept CSV and Excel files.

### Requirements

- first row contains headers
- each remaining row represents one recipient/email record
- columns may contain values like:
  - first_name
  - last_name
  - email
  - chapter
  - event_name
  - etc.

### Validation rules

- email field is required
- invalid email addresses are skipped
- rows with missing required variable values are skipped
- summary should show totals and skipped counts

### Example row

| first_name | last_name | email | chapter | event_name |
| --- | --- | --- | --- | --- |
| Alex | Smith | alex@example.com | Beta | Recruitment Night |

---

## 7. Variable Mapping Flow

After recipient upload, the user maps template placeholders to spreadsheet columns.

Example:

- {{first_name}} -> first_name
- {{last_name}} -> last_name
- {{email}} -> email
- {{chapter}} -> chapter
- {{event_name}} -> event_name

### Validation

- if a variable is not mapped, it may be left blank or be treated as missing
- if a required variable is missing, the row should be considered invalid for send
- preview should show a generated sample using the first valid row

---

## 8. Preview and Test Send Flow

### Step order

1. Load a template
2. Load recipient list
3. Map variables
4. Preview a sample email using the first valid record
5. Send a test email to a designated test address or the current admin email
6. Confirm the send before sending to the full list

### Preview behavior

- show the rendered message for the first valid row
- allow the admin to check subject, body, and recipient details
- allow editing before send

### Test send behavior

- send only one email to the admin or a test recipient
- show success/error feedback
- stop if provider config is missing or invalid

---

## 9. Send All Flow

### Send pipeline

- parse all rows
- validate email address
- validate required variable values
- skip invalid rows
- send only valid rows
- return a summary:
  - total rows
  - sent count
  - skipped count
  - invalid email count

### Skip behavior

- invalid rows should not crash the whole batch
- the admin should be able to see exactly which rows failed and why

### Suggested skip reasons

- invalid_email
- missing_required_value
- missing_mapping
- provider_error

---

## 10. Backend Requirements

The logic should live on the server-side or backend integration layer because the app needs to:

- validate auth
- securely hold provider credentials
- call the provider API or SMTP relay
- send emails without exposing secrets to browser clients

### Backend tasks

- receive payload from portal UI
- validate admin auth
- resolve provider settings
- render subject/body from template + row data
- perform send operation via provider
- track results and summary

---

## 11. Non-Goals for v1

This version should intentionally avoid overbuilding.

Not in scope for v1:

- automatic email tracing analytics
- queued jobs with retry system
- CRM syncing
- bounce handling
- unsubscribe management
- complex scheduling
- drag-and-drop template builder

The following are explicitly in scope for v1 under the SMTP model:

- multiple sender profiles
- chapter and personal email support
- secure admin-managed credentials
- shared starter templates

This keeps the project minimal, safe, and effective for chapter communication needs while still allowing multiple sending identities.

---

## 12. Recommended v1 Architecture

### Client-side

- portal page to upload templates and recipients
- sender profile selector
- template library and custom template upload
- variable mapping UI
- preview panel
- summary panel
- test-send and send-all buttons

### Server-side / integration layer

- auth validation
- sender profile lookup
- provider config lookup
- template rendering
- send request dispatch via SMTP
- send summary reporting

### Data storage

- Firebase auth and portal permissions for identity
- Firebase or portal-backed config storage for sender profile metadata and non-sensitive template metadata
- backend secure storage for provider credentials and secrets

### Sender profile model

Each sender profile should contain:

- profileId
- display name
- from address
- provider type
- host
- port
- secure connection type
- username
- encrypted password/token
- active flag
- createdBy
- lastUpdated

---

## 13. Acceptance Criteria

The feature is complete when:

- only authenticated admins can use the page
- the tool works with a generic SMTP-based provider model
- multiple sender profiles can be configured and selected
- chapter email and personal/alternate email sending are both supported
- a template can be selected from a starter library or uploaded
- CSV/Excel recipient data can be loaded
- placeholders can be mapped to columns
- a preview email renders correctly
- a test email can be sent successfully
- bulk sending sends valid rows and skips invalid ones
- summary results are visible after send
- secrets are not exposed in the frontend

---

## 14. Implementation Phase Plan

### Phase 1: Design and config

- confirm SMTP-first provider strategy
- define shared template list
- define sender profile model and fields
- define admin auth rules
- define how multiple chapter and personal sender profiles are stored securely

### Phase 2: Portal UI

- create email automation page
- add sender profile selector
- add template library and custom template upload
- add recipients upload
- add variable mapping UI
- add preview section

### Phase 3: Backend send layer

- implement secure sender profile config handling
- render emails from template and row data
- send test email from selected sender profile
- send bulk emails using selected sender profile
- return summary results

### Phase 4: QA and validation

- test with a small dataset using chapter sender profile
- test with a personal or alternate sender profile
- validate skip logic
- confirm provider auth works
- confirm no secret leakage
- confirm only admin users can trigger sends

---

## 15. Final Recommendation

For the chapter’s initial version, the best path is:

- SMTP-first provider architecture
- multiple sender profiles, including chapter and personal/alternate email identities
- shared starter template library for common communication needs
- admin-only access with strict auth validation
- secure backend storage for credentials

This keeps the feature simple, safe, and flexible while allowing the chapter to send from multiple configured identities without hardcoding Gmail or any single provider.
