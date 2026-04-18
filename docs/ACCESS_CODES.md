# Access Codes (v1.0 launch)

> Private. Do not commit any real code values to the repo. This file documents the model only.
> The real code list lives in `index.html` in a constant during v1; moves to Supabase in v1.1.

## Model

```js
const ACCESS_CODES = {
  'LAUNCH2026':    { tier: 'free',   uses: 100, expires: '2026-05-18' },
  'NEPHEW-APR18':  { tier: 'family', uses: 1,   expires: '2026-12-31', note: "nephew birthday" },
  'ELLA-2026':     { tier: 'family', uses: 1,   expires: '2027-01-01', note: "daughter" },
  'RSJ-ADMIN':     { tier: 'pro',    uses: 999, expires: '2099-01-01', admin: true },
};
```

## Rules

- Code is the only login credential in v1 (no email, no password, no PII)
- Display name is user-chosen and purely cosmetic
- Admin status elevated only for the RSJ-ADMIN code
- Tier gates which features are visible in the UI
- Code validation happens client-side in v1 (acceptable because all codes are private-invite)
- In v1.1, codes move to Supabase with proper row-level validation

## Generating new codes

Pattern: `{PURPOSE}-{IDENTIFIER}` -- uppercase, hyphen-separated, no lookalike characters.

Examples: `TEAM-JUN26`, `CAMP-XYZ`, `CLASS-MRSB`
