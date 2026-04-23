# Gmail Extractor

Bootstrap seed data for the pipeline. A Python script that authenticates with Gmail, queries your sent mail for a specific pattern, and produces a CSV of everyone you've emailed — name + inferred company + extracted organisations mentioned in the body.

Use it once to seed Sheet2 when you start; ignore it after.

---

## What it does

```
Gmail OAuth2  →  search (query)  →  fetch messages  →  parse headers  →
    → extract To/Cc names + emails
    → infer name from local part ("john.doe" → "John Doe")
    → infer company from domain ("doe@acme.com" → "Acme")
    → spaCy NER on body → extract PERSON + ORG mentions
    → dedupe + pandas → extracted_contacts_database.csv
```

---

## Setup

```bash
cd gmail-extractor
python -m venv .venv
source .venv/bin/activate          # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m spacy download en_core_web_lg
```

### OAuth credentials

1. [GCP Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) → **Create Credentials → OAuth client ID → Desktop**.
2. Download the JSON, save as `credentials.json` in this folder.
3. Enable the **Gmail API** on the same project.

`credentials.example.json` shows the shape:

```json
{
  "installed": {
    "client_id": "YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com",
    "project_id": "YOUR_GCP_PROJECT_ID",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_secret": "YOUR_OAUTH_CLIENT_SECRET",
    "redirect_uris": ["http://localhost"]
  }
}
```

`credentials.json` and `token.pickle` are `.gitignore`'d — do not commit them.

---

## Run

1. Open [`intelligent_extractor.py`](./intelligent_extractor.py) and edit `main()`:
   ```python
   SENDER_EMAIL = "your.email@example.com"    # who you sent from
   SUBJECT_LINE = "Job"                       # subject fragment to match
   ```
2. Run:
   ```bash
   python intelligent_extractor.py
   ```
3. First run opens a browser → consent to `gmail.readonly` → token cached to `token.pickle`.
4. Output: `extracted_contacts_database.csv` with columns:
   - `Message_ID, Date, Subject, Recipient_Email, Recipient_Name_From_Header, Recipient_Type, Inferred_Name_From_Email, Inferred_Company_From_Domain, Mentioned_Persons_In_Body, Mentioned_Orgs_In_Body`

---

## Using the output

The CSV columns don't match Sheet2's A-F schema one-to-one. Manual cleanup:

| CSV column | Sheet2 column |
|---|---|
| `Recipient_Name_From_Header` or `Inferred_Name_From_Email` | B: Full_Name |
| `Inferred_Company_From_Domain` | E: Organization |
| `Recipient_Email` | F: Email |
| (derive from spaCy ORGs in body) | C: Headline |
| (blank — fill from LinkedIn) | A: LinkedIn_URL, D: Designation |

Filter the CSV to keep only rows where you want the pipeline to email the person again. Paste columns A-F into Sheet2.

---

## Scopes

Only `https://www.googleapis.com/auth/gmail.readonly`. The script never modifies your mailbox.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `credentials.json not found` | Place the downloaded JSON in this folder as `credentials.json`. |
| `spaCy model not found` | `python -m spacy download en_core_web_lg` |
| Auth fails with `access_denied` | Your Gmail account isn't in the GCP project's OAuth consent **test users** list (if app is in Testing mode). |
| `Too many results` / pagination stalls | Tighten the search query (`after:YYYY/MM/DD`). |
