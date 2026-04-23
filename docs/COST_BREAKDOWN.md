# Cost Breakdown

All costs in Indian Rupees (INR), exchange rate ₹83 / USD (April 2026). Your mileage will vary by region and by which tiers you adopt.

---

## Per-service costs

| Service | Plan | Monthly (INR) | What it gets you |
|---|---|---|---|
| **Anthropic Claude** | Pay-as-you-go, Sonnet 4.5 | ~₹500–1,500 | Composition + follow-ups. At 25 drafts/day × 30 days = 750 calls × ~₹1 = ₹750/mo |
| **Google Gemini** | Free tier + pay-as-you-go | ₹0–400 | Research, grounded search, vision. 2.5 Flash is ~₹8 / 1,000 extractions |
| **Apollo.io** | Basic | ₹4,100 (~$49) | 900 profile lookups/mo, work + personal email |
| **Apollo.io** | Free | ₹0 | 120 lookups/mo (email credits only) |
| **RocketReach** | Free | ₹0 | 5 lookups/mo, graded emails + phones |
| **RocketReach** | Essentials | ₹3,250 (~$39) | 200 lookups/mo, full phone + email |
| **Hunter.io** | Free | ₹0 | 50 searches + 100 verifications/mo |
| **Hunter.io** | Starter | ₹2,850 (~$34) | 500 searches + 1,000 verifications |
| **Bright Data** | Optional, extension proxy | ₹0–2,000 | Residential proxy for extension (usually unnecessary) |
| **Google Sheets / Drive / Gmail** | Workspace free tier | ₹0 | Unlimited rows, 15 GB Drive, personal Gmail |
| **Google Apps Script** | Quotas | ₹0 | 6-min exec / 30 min compute per day. Well within pipeline needs. |

---

## Usage tiers

| Tier | Monthly | Profiles / mo | Components |
|---|---|---|---|
| **Starter** | ~₹4,100 | ~900 | Apollo Basic + free Gemini + Claude PAYG |
| **Pro** | ~₹6,950 | 900+ | Starter + Hunter Starter (higher email-match confidence) |
| **Pro + Phones** | ~₹10,200 | 900+ | Pro + RocketReach Essentials (phone discovery) |
| **Free / dev-only** | ₹0–500 | ~100 | Free tiers only, Claude PAYG capped at ~10 drafts/day |

---

## Cost per outcome

Assume a Starter tier user doing 100 drafts/month with a 5% reply rate and 20% meeting-book rate on replies:

| Metric | Value |
|---|---|
| Drafts sent | 100 |
| Replies | 5 |
| Meetings booked | 1 |
| Monthly cost | ~₹1,500 (Starter, partial month usage) |
| **Cost / meeting** | **~₹1,500** |
| Compare: LinkedIn Sales Navigator | ₹6,000+ / mo (plus your time) |
| Compare: Outbound agency | ₹30,000+ / mo retainer |

---

## Hidden costs to budget for

- **Domain warmup.** Use a dedicated `@yourbrand.com` domain, not your main. Warmup service ~₹2,000/mo for the first 2 months.
- **Google Workspace** (if you want `@yourbrand.com`): ₹125/user/mo for the basic tier.
- **Resume tweaks.** One-off ₹0 (you write them). The pipeline expects three variants.
- **Your time.** Expect ~1 hr/week of `REVIEW`-queue babysitting at first; drops to ~15 min/week once the fact bank is tuned.

---

## Cost ceilings configured in code

These are the hard limits — nothing exceeds them without a code change:

| Config | Default | Source |
|---|---|---|
| Drafts / day | 25 | `CONFIG.DAILY_DRAFT_LIMIT` |
| Sends / day | 20 | `CONFIG.DAILY_SEND_LIMIT` |
| Inter-draft delay | 3s | `CONFIG.MIN_DELAY_BETWEEN_DRAFTS_MS` |
| Batch size | 5 | `CONFIG.BATCH_SIZE` |
| Claude max tokens | 2,000 | `ApiClients.callClaude()` default |
| Gemini max tokens | 2,000 (4,000 grounded) | `ApiClients.callGemini()` default |

At default settings, the worst-case monthly spend is bounded at: `25 drafts/day × 30 days × (~1 Claude + ~2 Gemini calls per draft)` = ~2,250 LLM calls / mo ≈ ~₹2,000.
