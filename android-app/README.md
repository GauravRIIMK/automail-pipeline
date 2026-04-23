# LinkedIn Data Agent — Android App

The phone-first capture surface. A native Android app that watches the LinkedIn app, screenshots a profile on demand, extracts structured data via Gemini 2.5 Flash Vision, cross-validates emails through Apollo / RocketReach / Hunter, and pushes the result to your AutoMail Apps Script Web App.

> **Source policy:** The Android source (Java, Gradle, AndroidManifest) is maintained in a private repository and shipped as a signed APK. This folder documents the architecture, state machine, and integration contract so you can (a) understand what the APK does and (b) wire it into your own AutoMail instance. A future release will open-source the app.

---

## Architecture

### Runtime components

```
┌────────────────────────────────────────────────────────────────────┐
│                        Android Device                              │
│                                                                    │
│   ┌────────────────────┐           ┌──────────────────────────┐    │
│   │ LinkedIn app       │           │ LinkedInDataAgent        │    │
│   │ (user foreground)  │           │ (our app)                │    │
│   │                    │           │                          │    │
│   └──────────┬─────────┘           │  ┌────────────────────┐  │    │
│              │                     │  │ AccessibilityService│ │    │
│              │ window-state events │◄─┤ (listens to LinkedIn)│ │   │
│              │                     │  └──────────┬─────────┘  │    │
│              │                     │             │            │    │
│              │                     │  ┌──────────▼─────────┐  │    │
│              │ screenshot          │  │ StateMachine       │  │    │
│              ├────────────────────►│  │ (8 states)         │  │    │
│              │                     │  └──────────┬─────────┘  │    │
│              │                     │             │            │    │
│              │ post /exec          │  ┌──────────▼─────────┐  │    │
│              │                     │  │ EnrichmentChain    │  │    │
│              ▼                     │  │ (Apollo/RR/Hunter) │  │    │
│     Apps Script Web App            │  └──────────┬─────────┘  │    │
│                                    │             │            │    │
│                                    │  ┌──────────▼─────────┐  │    │
│                                    │  │ HttpClient         │  │    │
│                                    │  │ (POST to /exec)    │  │    │
│                                    │  └────────────────────┘  │    │
│                                    └──────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

### State machine (8 states)

```
IDLE
  │  user taps floating button
  ▼
SCREENSHOT_HEADER
  │  capture profile name + headline region
  ▼
SCROLLING
  │  scroll to contact info drawer
  ▼
SCREENSHOT_CONTACT
  │  capture email + phone + website
  ▼
PROCESSING_VISION
  │  send both screenshots to Gemini 2.5 Flash Vision
  │  label-adjacency extraction
  ▼
ENRICHING_EMAIL
  │  7-step email verification chain (see below)
  ▼
EXPORTING
  │  POST JSON → Apps Script /exec
  ▼
COMPLETE
  │  (timeout → ERROR, recover to IDLE)
  ▼
IDLE
```

Every state has a per-state timeout; a global safety timeout catches stuck edges. All transitions are logged to a remote endpoint so you can tail extractions from any browser.

---

## 7-step email verification chain

Emails are not just found — they're cross-checked:

1. **Apollo People Match** — verified work + personal email from Apollo's DB
2. **RocketReach Lookup** — graded confidence (A/B) email, plus phone
3. **Hunter Cross-Validation** — independent email search
4. **Hunter SMTP Verification** — confirms deliverability
5. **Pattern Generation** — 7 common patterns (`first.last@`, `f.last@`, `first@`, …) each verified via Hunter
6. **Gemini Discovery** — AI reasoning about likely email using all context
7. **Headline Parsing** — fallback: parse LinkedIn headline when APIs miss

Confidence scores:
- Apollo + RocketReach agree → **99%**
- Apollo + Hunter agree → **98%**
- Hunter SMTP verified → **95%**
- Pattern + Hunter verified → **85%**
- Gemini-inferred → **70%**
- Headline-parsed → **60%**

The confidence score ships in the POST payload (`confidence` field) and lands in Sheet1 column L.

---

## Integration contract

The app POSTs JSON to your Apps Script Web App:

**URL:** whatever you got from `Deploy → Web app` (ends in `/exec`)

**Body:**
```json
{
  "timestamp": "2026-04-23T09:12:34.567Z",
  "linkedinUrl": "https://www.linkedin.com/in/jane-doe",
  "fullName": "Jane Doe",
  "headline": "VP Engineering @ Acme | Scaling teams 10x",
  "currentDesignation": "VP Engineering",
  "currentOrganization": "Acme Corp",
  "email": "jane@acme.com",
  "phone": "+91-98xxxxxxxx",
  "website": "acme.com",
  "location": "Bangalore, India",
  "connectionDegree": "2nd",
  "confidence": "99"
}
```

**Response:**
```json
{ "status": "success", "automail_sync": "synced" }
```

See [gmail-apps-script/Code111.gs](../gmail-apps-script/Code111.gs) `doPost(e)` for the receiving end.

---

## Install

1. Download the latest APK from the release notes below (or copy from the private distribution).
2. On your Android 11+ phone:
   - **Settings → Security → Install unknown apps** — allow for your file manager.
   - Open the APK → Install.
3. First launch:
   - **Settings → Accessibility → LinkedIn Data Agent → enable** (required: app cannot run without accessibility).
   - **App settings → paste:**
     - Gemini API key
     - Apps Script Web App URL
     - (Optional) Apollo, RocketReach, Hunter keys
     - (Optional) Remote log endpoint URL
4. Open LinkedIn → any profile → tap the floating button.

---

## Innovations

| # | Innovation | Why it matters |
|---|---|---|
| 1 | **Hybrid screenshot + API** | Accessibility tree fails on LinkedIn's complex UI. Screenshots always work. |
| 2 | **Triple-source email validation** | Three independent sources cross-check each other → 99% confidence when any two agree. |
| 3 | **RocketReach phone discovery** | Fills the phone gap Apollo + Hunter often miss. |
| 4 | **Gemini fallback email discovery** | AI reasoning about first.last@company.tld patterns using all context. |
| 5 | **Label-adjacency algorithm** | Finds "Phone" / "Email" labels and grabs the next token — works across LinkedIn's many UI variations. |
| 6 | **"Present" keyword detection** | Finds current role by scanning experience dates for "Present" — fixes a recurring designation-mismatch bug. |

---

## Version history

| Version | Released | APK | Notes |
|---|---|---|---|
| 1.0 | March 2026 | `LinkedInDataAgent_v1.0.apk` | Initial release. 8-state machine, Gemini Vision, Apollo only. |
| 1.1 | April 2026 | `LinkedInDataAgent_v1.1.apk` | Added RocketReach + Hunter chain, SMTP verification, confidence scoring. |

---

## Roadmap

- [ ] Bulk extraction (URL list)
- [ ] Export to Salesforce / HubSpot / Zoho directly
- [ ] WhatsApp / Telegram bot (share a URL, get data back)
- [ ] AI lead scoring
- [ ] Multi-platform: Twitter, GitHub, AngelList
- [ ] **Open-source the app source** under MIT

See [../README.md § 8 Future Roadmap](../README.md) for the broader pipeline roadmap.
