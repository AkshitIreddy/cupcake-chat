# Owner video showcase output review — 2026-09-14

This is a read-only content audit of real persisted showcase replies against the synthetic source
bundles in `scripts/fixtures/owner-video-scenarios.json`. A provider response existing in the owner
profile is not acceptance by itself. Each failed item stays open until a new persisted reply is
checked against the source.

## Arithmetic and source checks used

### Grant report

- Distribution kilograms: `12 + 8 + 10 + 15 + 6 + 9 + 11 + 7 + 7 + 13 = 98` raw; remove one
  duplicate D-108 row of 7 kg, leaving `91 kg`.
- Distribution visits: 10 raw rows; remove one duplicate D-108 row, leaving 9 visits.
- Unique households: H-01 through H-08, leaving 8 unique households before and after duplicate
  removal.
- Receipts: `1240 + 3840 + 925 = INR 6005` raw; replace R-044 with 3480, leaving
  `1240 + 3480 + 925 = INR 5645`.
- Volunteer hours: S-021 is 4 hours and S-024 is 3.5 hours. S-031 has an invalid/unknown end time
  and is excluded, leaving 7.5 confirmed hours in both raw and corrected views.
- Missing ZIP: D-109 has a blank ZIP in the supplied raw data and remains one missing-ZIP record
  after correction.

### Shop reorder

- MUG target 36, available 30, gap 6, one 6-unit pack, INR 1500.
- BEANS target 25, available 30 including incoming, no order.
- FILTER target 32, available 14, gap 18, rounded to two 10-unit packs = 20 units, INR 900.
- SYRUP target 24, available 9, gap 15, five 3-unit packs = 15 units, INR 2700.
- CUP target 106, available 220 including incoming, no order.
- Full suggestion costs INR 5100. FILTER plus SYRUP costs INR 3600 and leaves INR 600; MUG cannot
  fit in the remaining budget.
- With source columns A:H, a usable row-2 suggested-quantity formula is
  `=IF((C2*D2+E2)-(B2+F2)<=0,0,CEILING((C2*D2+E2)-(B2+F2),G2))`. If suggested quantity is placed in
  I, cost is `=I2*H2`.

### Semester grades

- Statistics after the 80 project grade: `76*0.20 + 64*0.30 + 80*0.20 = 50.4`; `9.6 / 0.30 = 32`
  required on the final.
- Writing: `82*0.25 + 68*0.25 + 90*0.20 = 55.5`; `4.5 / 0.30 = 15` required on the final.
- Economics: `72*0.25 + 58*0.25 = 32.5`; 27.5 weighted points remain across 50%, so equal remaining
  scores of 55 reach 60 overall.
- Source deadlines are 17 September for the Economics presentation, 19 September for Writing, 22
  September for Statistics, and 24 September for the Economics final. Thursday has no study time.

## Reviewed results

### Grant report due at five — PASS after reviewed editor revision

Receipt: `E:\temp\cupcake-video-showcase-20260914\grant-report-audit-run.json`

The replies consistently use 101 kg raw and 94 kg corrected instead of 98 kg and 91 kg. They also
use INR 6455 raw instead of INR 6005. The final reconciliation says raw confirmed hours include
S-031 while giving the same 7.5-hour total that comes only from the two valid shifts, and says raw
missing-ZIP count is zero even though D-109 is blank in the source. The narrative says 9 visits is
lower than 8 households and invents a June 2024 reporting period. These errors affect the headline
artifact, so the conversation is not video-ready.

Suggested correction prompt:

> I checked the source rows and the arithmetic is wrong. The 10 distribution rows total 98 kg, not
> 101; removing one 7 kg D-108 duplicate leaves 91 kg. The receipt register totals INR 6,005, not
> 6,455; replacing R-044 3,840 with 3,480 leaves INR 5,645. D-109 is missing ZIP in both raw and
> corrected data. S-031 must be excluded from raw and corrected confirmed hours, so both are 7.5
> hours. Also 9 visits is more than 8 households, and no reporting year was supplied. Rewrite the
> complete copy-ready report with only those source-grounded figures, then recheck every sum before
> answering.

Latest follow-up review: the corrected reply fixes the headline kilograms, spend, visits, and
household figures. It still invents a 2024 reporting year, says raw confirmed hours include S-031
while using the two-valid-shift total, and gives a raw missing-ZIP count of zero even though D-109
is blank in the supplied data. A source-grounded editorial revision is staged below.

### A rainy Saturday in Mosswick — PASS after reviewed editor revision

Receipt: `E:\temp\cupcake-video-showcase-20260914\rainy-weekend-plan-run.json`

The selected museum route is directionally useful, uses the booked print studio, excludes the ferry
and clocktower, and keeps the museum ticket within budget. The fallback invents a direct
station-to-museum distance of 300 m and calls it covered. The source only supplies
station-to-library at 250 m and library-to-museum at 300 m via the covered arcade. The final also
places lunch in the museum row beside the GBP 24 ticket without stating that lunch remains unpriced
and excluded from the activity budget. It calls the library seating covered even though the source
gives no seating detail for the library, and treats the print studio as included in the budget when
the source only supplies the library as free and gives no separate studio price. Earlier replies
invent exact bus departures from a frequency-only statement, but those do not appear in the selected
final plan.

Suggested correction prompt:

> The fallback invented a direct station-to-museum 300 m covered route. The sheet only gives
> station-to-library 250 m and library-to-museum 300 m via the covered arcade. Rewrite the final
> phone plan and fallback using only supplied legs. At 10:40, go to the library first, then either
> catch the remaining print session or skip it before continuing to the museum. Say the print studio
> has no separate price listed, show the museum activity cost as GBP 24, and keep lunch cost
> unspecified and excluded from the GBP 55 activity budget. Do not invent seating, bus times,
> walking minutes, or route coverage; if you use walk times as planning buffers, label them as
> estimates rather than supplied facts.

Latest follow-up review: the direct-route error is removed and lunch is correctly unpriced, but the
reply still assigns five minutes to the 250 m leg and ten minutes to the 300 m leg after being told
no walking durations were supplied, then says all details came from the sheet. It also calls this a
museum day without allocating any museum visit: it reaches the museum, schedules lunch, and
immediately returns. A second correction should label travel windows as planning buffers and reserve
an actual museum period before leaving toward the station.

### One tiny change, again — PASS after corrective reply

Receipts: `E:\temp\cupcake-video-showcase-20260914\client-scope-creep-run.json` and
`client-scope-creep-followup.json`

The follow-up fixes the material calculation: 19 future add-on hours at EUR 75 = EUR 1425; the prior
three exploration hours remain internal and unbilled; the third revision is goodwill; delivery moves
from 18 to 25 October. The result still labels the add-on as approved while later requiring
approval. It labels the email “to be sent after approval” even though the email itself asks for that
approval, and leaves an insert-date heading and several placeholders. These contradictions make the
ostensibly copy-ready result feel unfinished.

Suggested correction prompt:

> The numbers are now right. Make the note genuinely ready to use: call the EUR 1,425 add-on
> proposed or pending approval, label the email as the approval request to send now, and remove the
> insert-date heading and unnecessary placeholders instead of inventing details. Keep the three
> unapproved exploration hours internal and unbilled, the third revision free, and delivery moving
> from 18 to 25 October.

Latest follow-up review: the user prompt explicitly supplied the fictional names Maya and Riya. The
recovered decision note and email consistently frame the EUR 1425 as a proposal awaiting approval,
keep the three old hours internal and unbilled, include the free two-hour revision, and propose 25
October. No remaining material content defect found.

### One CV, two very different jobs — PASS after reviewed editor revision

Receipts: `E:\temp\cupcake-video-showcase-20260914\truthful-cv-branches-run.json` and
`truthful-cv-branches-followup.json`

The original customer-success branch invents three years in the current role, daily escalation
handling, on-time supplier arrivals, prompt resolution, root-cause investigation, Excel escalation
logs and resolution-time tracking, escalation-procedure training, and outcomes such as customers
feeling heard. The first correction removes the three-year wording but still invents root-cause
investigation and follow-through, training in escalation handling, Excel use for documenting
interactions, and Google Workspace use for coordination. It also adds unsupported negative claims
about ticketing systems, automation tools, formal writing training, and limited customer contact.
The separate operations branch may remain intact, but this customer-success branch is not
source-faithful yet.

Suggested correction prompt:

> This customer-success version still adds evidence the source does not contain: root-cause
> investigation, following cases to resolution, training staff in escalation handling, using Excel
> to document interactions, and using Google Workspace for coordination. Rewrite only this Customer
> Success section. Use the bare supported facts: handles customer escalations; trains four weekend
> staff; previously led shifts of up to seven, prepared rotas, and reconciled tills; maintains 240
> SKUs; schedules 18 weekly deliveries; introduced the stated reorder reminder; Excel and Google
> Workspace are listed skills. Keep the explicit Salesforce and direct-sales gaps. Do not invent how
> tools were used, frequency, outcomes, or additional negative gaps.

Latest follow-up review: the unsupported tool-usage and resolution claims are gone. It still adds
that the four staff were trained on “daily procedures,” which is absent from the source, and omits
the requested skills-gap checklist entirely. A final narrow correction should say only that four
weekend staff are trained and include two defensible gaps: Salesforce is explicitly absent, and
customer onboarding is not evidenced in the supplied CV.

### What do I reorder before Monday? — PASS after reviewed editor revision

Receipts: `E:\temp\cupcake-video-showcase-20260914\shop-stock-reorder-run.json` and
`shop-stock-reorder-followup.json`

The arithmetic, priority order, pack sizes, INR 3600 order, and INR 600 remaining are correct. The
original spreadsheet formula reverses target and available, producing zero for shortages. The
follow-up reverses the subtraction correctly but still uses bare column letters such as `C*D`, which
is not a usable ordinary Excel formula, and gives `=M*H` for cost without defining M. This is a
material feature failure because the scenario is meant to demonstrate a reusable spreadsheet
formula.

Suggested correction prompt:

> The stock arithmetic is right, but the spreadsheet formulas still cannot be pasted into Excel
> because they use bare column letters. Give the final worksheet with a row-2 formula using the
> actual A:H layout: `=IF((C2*D2+E2)-(B2+F2)<=0,0,CEILING((C2*D2+E2)-(B2+F2),G2))`. Put Suggested
> Qty in I and use `=I2*H2` for cost in J. Keep the exact order of 20 FILTER and 15 SYRUP for INR
> 3,600, INR 600 left, and MUG on the watch list. Return a compact final worksheet only.

Latest follow-up review: the formulas now use usable row references, all calculations and the
proposed order are correct, and it clearly says nothing has been ordered. One internal label says
the sample data occupy rows 3–7 even though the formula starts at row 2 and the source data occupy
rows 2–6. Correct that label before using the worksheet in the video.

### Can I still pass this semester? — FAIL, editorial correction prepared

Receipt: `E:\temp\cupcake-video-showcase-20260914\semester-grade-rescue-run.json`

The grade arithmetic and risk ranking are correct. The final calendar repeats preparation after the
relevant deadlines: Economics presentation work after 17 September, Writing work after 19 September,
Statistics work after 22 September, and Economics final work after 24 September. It assigns weekday
names that do not match some listed dates, says to upload the presentation “today (Thursday)”
although the run date is Monday 14 September, and overstates mandatory study time. It also promises
the student will meet every requirement, which the plan cannot guarantee.

Suggested correction prompt:

> The grade maths is useful, but the calendar plan runs prep after the deadlines and adds wrong
> weekday labels. Rebuild one final rescue sheet for 14–24 September: nothing for the Economics
> presentation after the 17th, Writing after the 19th, Statistics after the 22nd, or Economics final
> after the 24th. Thursday has no study time. On each other weekday use one 45-minute must-do plus
> one optional 30-minute block; use at most 4 hours Saturday and 3 Sunday. Remove “today Thursday,”
> unsupported study-hour guarantees, and any promise that the student will pass. Keep the correct
> grade targets and a concise lecturer email.

Latest follow-up review: it still assigns incorrect weekday names, schedules Economics presentation
work on 20 September after the 17 September deadline, Statistics work on 23 and 25 September after
the 22 September final, and Economics work on unavailable 24 September. It calls 24 and 25 September
the weekend and again claims the workload fits comfortably. A date-specific editorial revision is
staged below.

### The support inbox is on fire — FAIL, editorial correction prepared

Receipt: `E:\temp\cupcake-video-showcase-20260914\support-inbox-triage-run.json`

The first reply correctly identifies T-201, T-205, and T-211 as P1, but says T-211 logged at 08:30
has 1 hour 30 minutes remaining at 10:00 and is still within its one-hour SLA. Its acknowledgment
deadline was 09:30, so it is already 30 minutes late. It also invents exact business-hour deadlines
for Friday P2/P3 tickets even though the source does not define business hours. Exact Friday
deadlines should remain unknown until business hours are supplied. The second reply says every agent
is at capacity while Jules has only T-205; T-208 is a P2 product issue and can use Jules's second
slot. The P1 draft acknowledgements claim investigation, log review, and testing have already begun,
although these are only drafts and no such action occurred. They also promise a 30-minute update
without that commitment being supplied. Reply four repeats the same problem: it says T-203 has been
forwarded, promises a refund before manager approval, guarantees a two-hour update, says T-210 was
already cancelled and will not renew, and says T-209 was logged. None of those actions occurred.
T-209 is unclassified; the defensible workflow is to recommend P3 based on low impact and then apply
the P3 SLA, rather than declare it outside the SLA.

The final artifact resets all P1 deadlines to 11:00. The actual one-hour clock deadlines are T-205
at 10:05, T-201 at 10:42, and T-211 at 09:30. It invents in-progress statuses and escalation
policies, repeats the unsupported completed-action claims, and assigns exact P2/P3 deadlines despite
the missing definition of business hours. It still leaves Jules's second slot unused. This artifact
is unsafe as an operational handoff.

Suggested correction prompt if the final retains these errors:

> Rebuild the final handoff from the source only. At Monday 10:00, P1 deadlines are T-205 10:05,
> T-201 10:42, and T-211 09:30, so T-211 is already 30 minutes overdue. First wave: Omar gets T-211
> and T-201; Jules gets T-205 and T-208; Kavya gets T-210 and T-203. Mark other tickets waiting.
> Business hours are not supplied, so do not invent exact P2/P3 deadlines; state their SLA rule and
> that the clock deadline needs business-hours confirmation. The only supplied escalation is manager
> review for T-203's INR 6,800 refund; use “none supplied” elsewhere. Label statuses as proposed
> assignment or awaiting action. Rewrite the six drafts without saying investigation, refund,
> cancellation, logging, or testing already happened, and without promising outcomes or update
> times. Recommend P3 for low-impact T-209. Never ask for passwords or full card numbers.

Latest follow-up review: despite the correction prompt, the table still calls proposed tickets
assigned, the drafts claim ownership and investigation have begun, and they promise 30-minute
updates. It collapses four different P3 deadlines to Tuesday 10:00, omits T-212 entirely, and omits
the sixth T-209 draft requested by the original scenario. A complete 12-ticket editorial revision
using the added 09:00–17:00 business-hours assumption is staged below.

### Teach me the orders sheet without making me feel stupid — PASS after reviewed editor revision

Receipt: `E:\temp\cupcake-video-showcase-20260914\spreadsheet-formula-coach-run.json`

Replies one through three correctly give `=C2*D2*(1-E2)`, the five row totals,
`=IF(AND(F2="Overdue",H2>7),"REVIEW","")`, and only O-102 as REVIEW. Reply four's displayed summary
formulas are correct, but its explanatory COUNTIFS example misspells `Overdue` as `Overdate`. It
does not show the expected summary results: INR 6495 total booked value, INR 2385 overdue booked
value, and one row needing review. Reply three also renders the Total formula inline with a
non-ASCII hyphen. The final artifact repeats the non-ASCII formula character, reports overdue booked
value as INR 2295 instead of INR 2385, and contains a nonsensical repeated formula in its first
“common mistake.” A corrected source-grounded one-page guide is staged below.

### The donor CSV that lies — PASS after reviewed revision and real Task

Evidence: `E:\temp\cupcake-video-showcase-20260914\donor-sandbox-task.json`

The initial model draft was retained, and the first execution attempt exposed an unsupported
`__future__` import rather than being presented as a pass. The reviewed user/editor revision has
SHA-256 `af3ee73ba7a1e0d6fd9fbf7de1524a2e1500387d9814ca74df54f518fe83cf41`. Its real saved-code Task
ran through `sandbox:packaged-worker-appcontainer-job`, exited with status zero, and recorded 18
tests run, zero failures, zero errors, and zero skipped. The test names cover the sample, required
headers, missing IDs and campaigns, email shape, amount parsing and validity, currency, real and
strictly shaped dates, whitespace, normalized duplicate forms, malformed CSV and row widths, large
distinct amounts, and non-echoing error output.

### Thirty-six broken things, one Saturday — PASS for group value, quiet closing unproven

Evidence: `E:\temp\cupcake-video-showcase-20260914\group\repair-cafe-group-verification.json`

The persisted group has three distinct personas, 12 unique assistant messages, two branches, and a
reviewed run-sheet artifact at SHA-256
`f7888ecc6d78aa1c95213d88f97006fd9568c0c03f5a0dd6819e4de435afb987`. One Smart turn completed with
two real Cohere replies, proving bounded multi-participant routing in this conversation. Five other
Smart-selection attempts ended with `GROUP_SELECTOR_INVALID`. The saved quiet-closing result is
therefore not proven and must not be shown or described as accepted behavior. The active branch is
`Event run sheet`.

### Where did my salary go? — PASS after reviewed editor revision

Receipt: `E:\temp\cupcake-video-showcase-20260914\private-subscription-cleanup-run.json`

The later arithmetic is correct: INR 48000 core, INR 11415 subscriptions, INR 59415 listed costs,
INR 12585 initial listed-cost remainder, INR 6899 planned savings, INR 52516 revised listed costs,
and INR 19484 revised listed-cost remainder. The final contradicts the user's choice by saying the
meal kit is reduced to once per month while removing its full INR 4200 cost. It describes cuts as
confirmed, paused, or cancelled even though the conversation only chose a plan and performed no
subscription actions. It calls INR 19484 “new breathing room,” although the incremental breathing
room is INR 6899, and repeats the unsupported, preachy claim that the user is not short of funds and
simply fails to prioritize savings. Unlisted spending is explicitly unknown. Earlier replies also
assume a subscription can be halved based on usage and contain inconsistent gap arithmetic, but the
final correction can supersede those exploratory errors.

Suggested correction prompt:

> Rewrite the one-page reset with totals first. These are planned cuts, not completed actions:
> cancel gym INR 1,800, meal kit INR 4,200, and language app INR 899. That frees INR 6,899 monthly;
> listed costs fall from INR 59,415 to INR 52,516, and the listed-cost remainder rises from INR
> 12,585 to INR 19,484 before unlisted spending. Do not say the meal kit is reduced, do not claim
> anything was cancelled, and remove judgments about savings priorities. Keep the checklist
> matter-of-fact.

The actual pre-created project memory uses key `Budget discussions: totals first, no lecture` and
protects work tools and backups, but its stored content does not explicitly preserve the family
contribution even though the chat's proposed preference says it does. The persisted memory should be
updated if the showcase claims that fuller rule was saved.

### What did we actually decide? — PASS after reviewed editor revision

Receipt: `E:\temp\cupcake-video-showcase-20260914\meeting-decision-brief-run.json`

Cost, storage, current-stock duration, ownership, drop-test rule, and the tentative 1 October target
are mostly correct. The final timeline is impossible: the sample can arrive on 18 September only if
Jin confirms by 12 September noon, and Marco then needs two working days after sample arrival.
Replies four and six set the next go/no-go on 18 September and expect the sample, print-check
result, and drop-test result by then. They also describe the conditional sample as confirmed. A
Friday 18 September agenda cannot reasonably ask for Marco's completed two-working-day print result.
The exact later decision date is not supplied. Jin is the named confirmation owner, Marco is the
named print-check owner, Priya and Marco jointly own the drop test, and other ownership should
remain unassigned.

Suggested correction prompt:

> The go/no-go timing is impossible. The sample can arrive 18 September only if Jin confirms by 12
> September noon; Marco then needs two working days after arrival for the print check. Rewrite the
> final brief and Friday agenda. Make the next go/no-go after the sample arrives, Marco's
> two-working-day check is complete, and Priya plus Marco complete the ten-drop test; no exact
> decision date is supplied. Jin owns confirmation, Marco owns print check, Priya and Marco own drop
> test, and other owners remain unassigned. Keep 1 October desirable, not committed.

The initial meeting memory did not explicitly store the requested tentative-date wording. The
operator subsequently saved the corrected memory through the app; `memory-updated.json` and the
final reopened inventory establish the current preference and its persistence.

## Acceptance rule for corrections

For each failed item, retain the original real response and model-authored artifact revision. A
natural model correction or a clearly attributed user/editor revision may supersede it. Verify the
new content against the exact source arithmetic and constraints above, and never represent editor
work as another model response. Do not mark a scenario accepted from a prompt being sent, a provider
returning successfully, or an editor file merely existing; inspect the persisted result.

## Reviewed editorial proposals staged for artifact revisions

These files do not change conversation history or claim to be model responses. They are
source-grounded editor proposals for new artifact revisions, with the original real model revisions
retained underneath them. All nine were observed in the app's editorial-application logs as new
`authorKind:user` revisions. The first seven matched the earlier direct verification, and
`verification-semester-support.json` matches the two later revisions and reviewed hashes. The full
collection verification was regenerated after the group scenario and final artifact organization.
The hashes below identify the first reviewed content. Grant, stock and support later received
layout-only revisions to replace wide tables; current hashes are in `verification.json` and their
editorial receipts.

| Scenario             | Proposal                                                                            | SHA-256                                                            | Review result                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Rainy weekend        | `E:\temp\cupcake-video-showcase-20260914\editorial\rainy-weekend-plan.md`           | `695DEBB278985E21590D90A1C1DAA666C87F2ADA4F06D581C0993061C66A543C` | Adds an actual museum visit; all walk durations are explicitly planning buffers; fallback uses only known legs.                       |
| CV branch            | `E:\temp\cupcake-video-showcase-20260914\editorial\truthful-cv-branches.md`         | `AD15D68ECDF7FAD74E3924ADA06675FAA72B656D3413AE8D21D36B0C54B80364` | Removes invented training detail and adds only the two source-defensible gaps.                                                        |
| Stock reorder        | `E:\temp\cupcake-video-showcase-20260914\editorial\shop-stock-reorder.md`           | `5B99504849A0E7E8F37EC70747CF5A7491C956E382E2786F78F4B6602743AD9F` | Corrects the sample range to rows 2–6 and keeps the verified formulas and order.                                                      |
| Private budget       | `E:\temp\cupcake-video-showcase-20260914\editorial\private-subscription-cleanup.md` | `5E2D6C470973502F4A4E3EDCA748F2DC48B381A4FFDCC31248E4E679A3DADC4A` | Corrects the subscription list, distinguishes incremental savings from remainder, and removes the mislabeled unlisted-spending total. |
| Meeting brief        | `E:\temp\cupcake-video-showcase-20260914\editorial\meeting-decision-brief.md`       | `EE2FFB428E749B5196BF5DB3FE80822414D0EB0362996A1F4695F47D3F60BE26` | Keeps the later go/no-go conditional and makes Friday request scheduling evidence rather than impossible completed tests.             |
| Grant report         | `E:\temp\cupcake-video-showcase-20260914\editorial\grant-report-audit.md`           | `E47F1F85FC47EA8F4B4B7CF2F649F6931F7A8FCF4A45D678865D4615F914D0E3` | Removes the invented year and fixes raw confirmed-hours and missing-ZIP reconciliation.                                               |
| Orders formula guide | `E:\temp\cupcake-video-showcase-20260914\editorial\spreadsheet-formula-coach.md`    | `072EF342D9CCB7E40DB4C6FFAF0E8441AD3A41093281FCBAD3610A3BE7167120` | Fixes the overdue total, copyable minus signs, summary outputs, and common-mistake guidance.                                          |
| Semester rescue      | `E:\temp\cupcake-video-showcase-20260914\editorial\semester-grade-rescue.md`        | `A8AAFA54CC7F92C8F83D883F08C5F7FA60DFE694EEB09BE7F3847B2FB294A17B` | Stops work at each deadline, respects unavailable Thursdays, and removes guarantees.                                                  |
| Support triage       | `E:\temp\cupcake-video-showcase-20260914\editorial\support-inbox-triage.md`         | `8328779F74C368CFA816101A19AFE7D910B7FACA44B92FB415D77205A043219B` | Includes all 12 tickets, exact SLA clocks, bounded proposed owners, and drafts that claim no completed action.                        |

## Short closing-reply audit

Nine real closing replies were requested with the reviewed artifacts as typed context. The replies
were not rewritten. Receipt names end in `-closing.json` under the proof root.

| Scenario        | Result                          | Review                                                                                                                                                                                  |
| --------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grant report    | Pass                            | Gives the three unresolved follow-ups without claiming they were performed.                                                                                                             |
| Semester rescue | Pass                            | Points to the lecturer email, Economics presentation, and first Statistics block without promising a grade.                                                                             |
| Stock reorder   | Pass                            | Keeps FILTER 20, SYRUP 15, INR 4200 cash, and the MUG watch item consistent.                                                                                                            |
| Rainy weekend   | Pass after second closing reply | Starts with the supplied 250 m station-to-library leg and uses the corrected itinerary.                                                                                                 |
| Orders formula  | Pass after second closing reply | Starts with the correct ASCII formula in G2 and the correct fill-down range.                                                                                                            |
| Meeting brief   | Use reviewed artifact           | The next step checks Jin's confirmation, but the reply overstates that missing confirmation makes sample arrival impossible. The reviewed artifact correctly leaves timing conditional. |
| Private budget  | Pass after second closing reply | Starts by confirming effective cancellation dates without claiming a cancellation occurred.                                                                                             |
| Support triage  | Pass after third closing reply  | Confirms that owners accept proposed assignments first and customer acknowledgements are then sent immediately; it makes no new SLA-clock claim.                                        |
| CV branch       | Pass after third closing reply  | Starts by applying the four reviewed bullets, then completing and personalizing the email before any send step.                                                                         |
