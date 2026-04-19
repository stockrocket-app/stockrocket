-- =============================================
-- StockRocket -- Study (Academy) Schema
-- =============================================
-- Apply in App Lab Supabase SQL Editor.
-- Auth model matches 002: no Supabase Auth. Access via X-User-Code header,
-- enforced by Edge Functions using the service_role key. RLS stays OFF.
--
-- Tables:
--   stockrocket_playbooks              -- 6 mental-model cards (static content)
--   stockrocket_teardowns              -- company deep-dives (static content)
--   stockrocket_predictions            -- user submissions + resolved scoring
--   stockrocket_teardown_completions   -- who-read-what (progress tracking)
--
-- v0 ships with all 6 playbooks unlocked for every user. Unlock gating
-- (playbooks unlock only after reading linked teardowns) is a v1 addition
-- that only needs a stockrocket_playbook_unlocks table to wire in later.

-- ===============================================================
-- PLAYBOOKS (static content -- 6 mental models)
-- ===============================================================
CREATE TABLE IF NOT EXISTS stockrocket_playbooks (
  slug              TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  author_name       TEXT NOT NULL,
  summary           TEXT NOT NULL,
  example_symbol    TEXT,
  example_period    TEXT,
  body              TEXT NOT NULL,
  order_hint        INT NOT NULL DEFAULT 99,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===============================================================
-- TEARDOWNS (static content -- company deep-dives)
-- ===============================================================
-- body is structured JSON so the client can render sections without
-- special-case parsing. Each section has:
--   { type: 'prose' | 'stats_and_prose' | 'bull_bear' | 'questions',
--     label: 'The Moat', ...type-specific fields }
CREATE TABLE IF NOT EXISTS stockrocket_teardowns (
  slug                    TEXT PRIMARY KEY,
  symbol                  TEXT NOT NULL,
  title                   TEXT NOT NULL,
  difficulty              TEXT NOT NULL CHECK (difficulty IN ('beginner','intermediate','advanced')),
  linked_playbooks        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  estimated_read_minutes  INT NOT NULL DEFAULT 10,
  body                    JSONB NOT NULL,
  author                  TEXT,
  status                  TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','archived')),
  published_at            TIMESTAMPTZ DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stockrocket_teardowns_symbol ON stockrocket_teardowns(symbol);
CREATE INDEX IF NOT EXISTS idx_stockrocket_teardowns_status ON stockrocket_teardowns(status);

-- ===============================================================
-- PREDICTIONS (user submissions -- the forcing function)
-- ===============================================================
-- Scoring rule:
--   direction correct? +40 pts base
--   proximity bonus? up to +60 pts based on how close target_price was
--   final points = base_score * confidence (1-5)
--   wrong direction = 0 pts
CREATE TABLE IF NOT EXISTS stockrocket_predictions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_code               TEXT NOT NULL,
  symbol                  TEXT NOT NULL,
  asset_type              TEXT NOT NULL CHECK (asset_type IN ('stock','crypto')),
  teardown_slug           TEXT,            -- which teardown inspired it (nullable)
  playbook_slug           TEXT NOT NULL,   -- REQUIRED citation
  direction               TEXT NOT NULL CHECK (direction IN ('UP','DOWN')),
  target_price            NUMERIC(20,4) NOT NULL,
  target_date             DATE NOT NULL,
  confidence              INT NOT NULL CHECK (confidence BETWEEN 1 AND 5),
  rationale               TEXT NOT NULL,
  -- submission snapshot
  submitted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_price         NUMERIC(20,4) NOT NULL,
  submitted_price_source  TEXT,
  -- resolution fields (null while open)
  resolved_at             TIMESTAMPTZ,
  resolved_price          NUMERIC(20,4),
  resolved_price_source   TEXT,
  outcome                 TEXT CHECK (outcome IN ('correct_direction','wrong_direction','no_data')),
  accuracy_score          NUMERIC(6,2),    -- 0-100 before confidence multiplier
  points_awarded          NUMERIC(8,2)     -- accuracy_score * confidence
);

CREATE INDEX IF NOT EXISTS idx_stockrocket_predictions_user        ON stockrocket_predictions(user_code, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_stockrocket_predictions_open        ON stockrocket_predictions(target_date) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_stockrocket_predictions_symbol      ON stockrocket_predictions(symbol);
CREATE INDEX IF NOT EXISTS idx_stockrocket_predictions_teardown    ON stockrocket_predictions(teardown_slug) WHERE teardown_slug IS NOT NULL;

-- ===============================================================
-- TEARDOWN COMPLETIONS (progress tracking)
-- ===============================================================
-- Writes on first reader-open of a teardown by a given user. Single row
-- per (user, teardown) pair -- subsequent opens are no-ops. Useful for
-- "you've read 3 of 8 teardowns" progress plus eventual unlock gating.
CREATE TABLE IF NOT EXISTS stockrocket_teardown_completions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_code       TEXT NOT NULL,
  teardown_slug   TEXT NOT NULL,
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_code, teardown_slug)
);

CREATE INDEX IF NOT EXISTS idx_stockrocket_teardown_completions_user ON stockrocket_teardown_completions(user_code);

-- ===============================================================
-- SEED: PLAYBOOKS (6 mental models)
-- ===============================================================
-- ON CONFLICT DO UPDATE so we can re-run this file after copy edits.
INSERT INTO stockrocket_playbooks (slug, title, author_name, summary, example_symbol, example_period, order_hint, body) VALUES

('moat',
 'The Moat',
 'Warren Buffett',
 'Buy businesses that are protected from competition, not just winning today.',
 'KO',
 '1988-present',
 1,
 $body$Buffett's one-line rule: look for economic castles surrounded by wide moats. A great product is not a moat. A great moat is something that stops competitors from eating your lunch even when they try hard. There are five classic moat types. Brand (Coca-Cola, Apple). Network effects (Visa, Facebook). Switching costs (Microsoft Office, Salesforce). Scale advantages (Costco, Amazon). Patents or regulation (Pfizer drugs, utility monopolies).

When Buffett bought Coca-Cola in 1988, he wasn't betting on the next six months of sales. He was betting that in 50 years, people would still drink Coke, the brand would still command a premium, and no competitor could realistically dislodge it. He paid about $1.3B. That position is now worth ~$25B plus dividends.

When you evaluate a stock, the first question isn't "is the business growing?" The first question is "what stops a competitor from copying this in five years?" If you can't name the moat in one sentence, there isn't one.$body$),

('margin-of-safety',
 'Margin of Safety',
 'Benjamin Graham',
 'Pay less than the business is worth today. The gap is your insurance policy.',
 'BRK.B',
 '1973-1974 bear market',
 2,
 $body$Graham taught Buffett this one. Your estimate of a company's fair value is always wrong. The question is not whether you can be right, but whether you leave enough room to be wrong and still make money. If you think a business is worth $100 per share, don't pay $95. Pay $60. The $40 gap is your margin of safety.

During the 1973-1974 bear market, Buffett bought Washington Post at roughly a quarter of its appraised value. He wasn't making a precise prediction. He was buying so cheap that even if his analysis was partly wrong, he'd still make money. He made 100x over the next 30 years.

In practice: use conservative assumptions. Assume growth is slower than bulls claim. Assume margins compress. Assume management does something dumb at some point. If the business still looks cheap under those assumptions, you have a margin of safety. If it only works when everything goes right, you don't.$body$),

('ten-bagger',
 'The 10-Bagger',
 'Peter Lynch',
 'Great returns come from holding exceptional businesses for years, not trading weekly.',
 'WMT',
 '1970-1990',
 3,
 $body$Lynch ran the Magellan Fund from 1977 to 1990 and returned 29% a year. His rule: the biggest returns come from stocks that go up 10x or more, what he called "ten-baggers." You don't need many. One or two ten-baggers can make your whole portfolio.

The catch is you have to hold them. Most people sell when a stock doubles, because doubling feels great. Lynch's point is that a double is where ten-baggers start, not where they end. Wal-Mart went up 1,000x from its 1970 IPO to 1990. Anyone who sold at 2x missed 99% of the gain.

How do you find ten-baggers? Lynch's answer: invest in what you know. If a product is visibly taking over in your life, that's signal. Starbucks when it first appeared on your corner. Netflix when everyone cancelled cable. You see these before Wall Street writes about them. Your edge as an amateur is noticing what Wall Street dismisses as anecdotal.

Lynch's warning: ten-baggers feel uncomfortable the whole way up. You'll want to sell at every peak. Don't.$body$),

('ride-winners',
 'Ride Winners, Cut Losers',
 'Jesse Livermore',
 'Sit tight when you''re right. Move fast when you''re wrong.',
 'SPY',
 'general rule',
 4,
 $body$Livermore was the greatest speculator of the early 20th century. His ruin came from breaking his own rules. His most important rule, learned hard: most traders do the exact opposite of what works. They sell winners to "lock in gains" and hold losers hoping for a comeback.

The math is merciless. If you sell every winner at +20% and hold every loser until -40%, you need a 67% win rate just to break even. Meanwhile a trader who holds winners to +100% and cuts losers at -10% can be right only 30% of the time and still crush the market.

The rule: when a trade works, do nothing. Let it compound. When a trade doesn't work, exit without argument. The position told you something by going against you. Listen.

Hardest part: this rule feels wrong emotionally. Taking a loss feels like admitting you were wrong. Holding a winner through a pullback feels like you're about to give back the gain. Trained traders learn to override both instincts. Untrained traders lose money forever because they won't.$body$),

('trend-is-friend',
 'The Trend Is Your Friend',
 'Nicolas Darvas',
 'Don''t fight the tape. Price action is the final judge of whether you''re right.',
 'NVDA',
 '2023-2024',
 5,
 $body$Darvas was a ballroom dancer who made $2M trading stocks in the late 1950s by one rule: he only bought stocks making new highs in strong markets, and he sold anything that broke down through his stop. He didn't care about the story. He cared about the tape.

The lesson isn't "momentum always works." The lesson is that your opinion of a stock and the stock's actual behavior can disagree for a long time. When they disagree, the stock wins. Holding a falling stock because "the fundamentals are still good" is a common way to lose money. The tape knows things you don't.

NVDA from 2023 to 2024 was a textbook example. Every month a respected analyst called it overvalued. Every month the stock went higher. The tape was pricing in the AI buildout faster than DCF models could catch up. Following the trend was the right answer; fighting it cost people a 5x return.

The counter-rule: trends reverse. The same tape that confirms you're right will eventually tell you you're wrong. Your job is to listen in both directions, not just the one you like.$body$),

('asymmetric-bet',
 'The Asymmetric Bet',
 'Stanley Druckenmiller',
 'Size your bets so being wrong costs little and being right pays a lot.',
 'BTC',
 '2020-present',
 6,
 $body$Druckenmiller never had a losing year in 30 years of running money. His framework: the game is not to be right more often. The game is to structure every bet so that when you ARE right, you make many multiples of what you lose when you're wrong.

The math: a bet where you make 5x when right and lose 1x when wrong is profitable even if you're only right 25% of the time. A bet where you make 1x when right and lose 1x when wrong is break-even only if you're right >50% of the time, which nobody consistently is.

The application: position sizing matters more than being right. If an idea has 10x upside and 1x downside, put 5% of your portfolio on it. If an idea has 50% upside and 50% downside, skip it. The payoff shape determines whether an idea is worth any position at all.

This framework is what makes small positions in highly volatile assets (like Bitcoin, or a small-cap turnaround) rational. You only need one to work to pay for many that don't. The key word is "only." You don't bet the farm on asymmetric ideas. You bet small enough that being wrong teaches you a lesson, and being right changes your life.$body$)

ON CONFLICT (slug) DO UPDATE SET
  title          = EXCLUDED.title,
  author_name    = EXCLUDED.author_name,
  summary        = EXCLUDED.summary,
  example_symbol = EXCLUDED.example_symbol,
  example_period = EXCLUDED.example_period,
  body           = EXCLUDED.body,
  order_hint     = EXCLUDED.order_hint,
  updated_at     = now();

-- ===============================================================
-- SEED: TEARDOWNS (AAPL, NVDA, BTC)
-- ===============================================================
-- AAPL
INSERT INTO stockrocket_teardowns (slug, symbol, title, difficulty, linked_playbooks, estimated_read_minutes, author, body) VALUES
('aapl-deep-dive',
 'AAPL',
 'Apple: The World''s Most Beloved Moat',
 'beginner',
 ARRAY['moat','margin-of-safety'],
 10,
 'RSJ',
 $json$
{
  "sections": [
    {
      "type": "prose",
      "label": "The Business Model",
      "body": "Apple makes money three ways. First, it sells premium consumer hardware: iPhone, Mac, iPad, AirPods, Apple Watch. iPhone alone is about half the company's revenue. Second, it sells services that ride on top of that hardware: App Store fees, iCloud storage, Apple Music, Apple TV+, Apple Pay. Services are roughly a quarter of revenue, growing faster than hardware, with much higher margins. Third, a growing wearables and accessories segment.\n\nThe cycle that makes Apple special: you buy an iPhone, you get locked into the ecosystem, Apple earns from you for the next decade through services and your next iPhone. Every installed device is an annuity."
    },
    {
      "type": "prose",
      "label": "The Moat",
      "body": "Apple's moat is ecosystem lock-in plus brand. Switching from iPhone to Android means losing your iMessage blue bubbles, your AirPods pairing, your Apple Watch, your App Store purchases, your iCloud photos, your family sharing. The cost of switching is emotional and practical. Combined with a brand that commands a 40% premium over comparable hardware, this moat has held for 15+ years.\n\nBuffett bought about $150B worth of Apple because he concluded this is one of the most durable consumer businesses ever built. That's the highest compliment the most famous moat investor in history can give a company."
    },
    {
      "type": "stats_and_prose",
      "label": "Recent Earnings Snapshot",
      "stats": [
        {"label": "Revenue (Q)", "value": "$95B"},
        {"label": "EPS", "value": "$1.50"},
        {"label": "Gross Margin", "value": "46%", "pos": true},
        {"label": "Returned To Shareholders", "value": "$29B"}
      ],
      "body": "Services growing ~12% year over year, iPhone growing ~3%. Gross margin near royalty-level profitability. Apple returned roughly $29B to shareholders last quarter via buybacks and dividends. No meaningful debt problem. This is a cash-printing machine with an operator CEO."
    },
    {
      "type": "bull_bear",
      "label": "Bull vs Bear",
      "bull": [
        {"title": "Services flywheel.", "body": "More than 2B active Apple devices worldwide, each generating high-margin service revenue forever. This is the business Buffett cares about most."},
        {"title": "AI catalyst.", "body": "Apple Intelligence is shipping across the iPhone lineup. If it convinces the installed base to upgrade at scale, this could be the biggest cycle since iPhone 6."},
        {"title": "Capital returns.", "body": "Apple has bought back roughly 40% of its shares since 2013. Even if revenue flatlined, EPS would keep climbing because the denominator keeps shrinking."}
      ],
      "bear": [
        {"title": "China exposure.", "body": "~17% of revenue comes from China and geopolitical friction is rising. Huawei's domestic resurgence is real. A slow-motion market-share loss could shave growth every year."},
        {"title": "Innovation lull.", "body": "Vision Pro underwhelmed. The Apple Car was cancelled after 10 years and billions invested. Where does the next $100B product line come from?"},
        {"title": "Valuation.", "body": "Apple trades at roughly 30x forward earnings. Historically: 12-18x. A multiple compression alone could mean 20-30% downside, even if fundamentals hold."}
      ]
    },
    {
      "type": "prose",
      "label": "Management Quality",
      "body": "Tim Cook is an operator, not a visionary, and that's exactly what a moat business needs. Since taking over in 2011 he has tripled revenue, quadrupled EPS, and returned more than $800B to shareholders. Criticisms about the innovation bench are legitimate, but execution and capital allocation have been textbook. Watch the CFO transition: Luca Maestri stepped down in 2025, and how the new CFO handles capital returns and China commentary will matter."
    },
    {
      "type": "questions",
      "label": "Three Guided Questions",
      "questions": [
        "Buffett's rule: \"Only buy something that you'd be perfectly happy to hold if the market shut down for 10 years.\" Would you hold Apple for 10 years with no ability to sell? What would have to be true about the business for you to feel comfortable?",
        "What breaks the moat? Describe one realistic scenario, not a doomsday one, where the iPhone ecosystem loses its grip on consumers.",
        "If Apple dropped 30% tomorrow on no company-specific news, would you buy more, hold, or sell? Your answer reveals whether you actually believe your thesis or whether you're just along for the ride."
      ]
    }
  ]
}
$json$::jsonb),

-- NVDA
('nvda-deep-dive',
 'NVDA',
 'Nvidia: The Pick-and-Shovel of the AI Gold Rush',
 'intermediate',
 ARRAY['ten-bagger','trend-is-friend','moat'],
 12,
 'RSJ',
 $json$
{
  "sections": [
    {
      "type": "prose",
      "label": "The Business Model",
      "body": "Nvidia designs graphics processing units, chips originally built for video games, now the universal hardware for AI training and inference. They don't manufacture the chips themselves; TSMC does that. Nvidia's real product is the combination of silicon plus software (CUDA plus a library stack) that makes those chips faster than anyone else's for AI workloads.\n\nToday the business is ~85% data center, ~10% gaming, and a long tail of automotive, professional visualization, and robotics. Customers are the hyperscalers (Microsoft, Google, Meta, Amazon) followed by every enterprise trying to deploy AI. During the California gold rush, the people who got rich weren't the prospectors; they were the ones selling picks and shovels. Nvidia is that."
    },
    {
      "type": "prose",
      "label": "The Moat",
      "body": "CUDA. Nvidia spent 17 years building the software layer that every AI researcher and engineer has been trained on. Switching to AMD, Google TPU, or a custom chip means rewriting your AI stack, retraining your engineers, and accepting benchmarks that are often worse. The software moat is deeper than the hardware lead.\n\nAMD has competitive silicon on paper. It doesn't matter if the tooling is worse. Plus Nvidia's systems-level approach (NVLink for chip interconnect, InfiniBand via the Mellanox acquisition, reference server designs) makes them a full-stack supplier, not just a chip vendor. A hyperscaler ordering from Nvidia gets a complete AI factory. A hyperscaler ordering from a competitor gets boxes and a homework assignment."
    },
    {
      "type": "stats_and_prose",
      "label": "Recent Earnings Snapshot",
      "stats": [
        {"label": "Revenue (Q)", "value": "$30B"},
        {"label": "YoY Growth", "value": "+120%", "pos": true},
        {"label": "Gross Margin", "value": "75%", "pos": true},
        {"label": "Net Income (Q)", "value": "$17B"}
      ],
      "body": "Data center revenue around $26B of the $30B total. These numbers are unlike anything in semiconductor history. Forward guidance assumes continued hyperscaler capex through the next several quarters."
    },
    {
      "type": "bull_bear",
      "label": "Bull vs Bear",
      "bull": [
        {"title": "AI is a 10-20 year build-out.", "body": "Training frontier models, then serving inference at global scale, then sovereign AI, then robots and cars. The demand curve compounds. Nvidia is the default provider across every layer."},
        {"title": "Software moat deepens over time.", "body": "Every new AI framework, every new research paper, every new LLM targets CUDA first. Each year makes switching harder, not easier."},
        {"title": "New markets still opening.", "body": "Sovereign AI (countries building national compute), robotics, drug discovery, autonomous vehicles. Each is a separate multi-year market that didn't exist five years ago."}
      ],
      "bear": [
        {"title": "Cyclical risk.", "body": "If hyperscalers pause capex in 2026 because they've bought enough, Nvidia's revenue flatlines overnight and the multiple compresses hard."},
        {"title": "Customer concentration.", "body": "Four customers (MSFT, GOOG, META, AMZN) make up ~40% of data center revenue. If they slow spending at the same time, the stock falls first and fastest."},
        {"title": "Competition and custom silicon.", "body": "AMD's MI300 is gaining share. Google's TPU, Amazon's Trainium, Meta's MTIA are all in-house chips. At some scale, every hyperscaler is incentivized to build their own."}
      ]
    },
    {
      "type": "prose",
      "label": "Management Quality",
      "body": "Jensen Huang founded Nvidia in 1993 and has run it for 31 years. He owns roughly 3% of the company. One of the best technical CEOs alive, engineers respect him because he can talk engineering at depth. His survival of multiple near-death moments (the crypto mining crash of 2018, the gaming-only era, the attempted ARM acquisition failure) is why Nvidia is what it is today.\n\nThe real risk here is succession. There's no obvious number two, and Jensen is 61. When he eventually hands over, the stock will test how much of Nvidia's edge was the company and how much was the man."
    },
    {
      "type": "questions",
      "label": "Three Guided Questions",
      "questions": [
        "Lynch says a \"ten-bagger\" is a stock that returns 10x. Nvidia has done that several times over. Is it too late, or is the AI supercycle just beginning? Pick a side and defend it with something more specific than vibes.",
        "What's the first sign that the AI capex cycle is peaking? Name three leading indicators you'd watch, things that would change before earnings actually miss.",
        "If Microsoft announced tomorrow that they had a custom chip matching H100 performance, what happens to NVDA stock? Bigger question: how likely is that scenario, and how would you hedge if you wanted to stay long?"
      ]
    }
  ]
}
$json$::jsonb),

-- BTC
('btc-deep-dive',
 'BTC',
 'Bitcoin: Digital Scarcity as an Asset Class',
 'advanced',
 ARRAY['asymmetric-bet','trend-is-friend','ride-winners'],
 12,
 'RSJ',
 $json$
{
  "sections": [
    {
      "type": "prose",
      "label": "The \"Business Model\" (There Isn't One)",
      "body": "Bitcoin doesn't have a business model. No cash flows. No earnings. No management team. No product pipeline. This is the first thing that makes it hard to analyze with the tools you use for stocks.\n\nWhat Bitcoin has instead is a fixed supply (21 million coins, ever, enforced by cryptographic rules no one can change) and a distributed global network of computers verifying transactions without any central issuer. You own Bitcoin the way you own gold: its value is whatever other people agree it's worth, backed by scarcity and adoption. The thesis is that in a world where every traditional currency can be printed at will, a provably finite digital asset plays a monetary role.\n\nIf you find that thesis silly, that's fine. Many serious people do. The point of studying Bitcoin is to understand how an asset class you may not own works, because a meaningful chunk of global wealth now flows through it."
    },
    {
      "type": "prose",
      "label": "The \"Moat\"",
      "body": "Bitcoin's moat is network effects plus the Lindy effect. It has survived 16 years of attacks, forks, government bans, exchange collapses, crashes, and ridicule. Every year it doesn't die adds to the probability it never dies. The 21M cap cannot be changed without breaking the chain, which is the chain's whole value proposition.\n\nNo other cryptocurrency has Bitcoin's security budget (the total energy securing the network), its regulatory clarity (the US SEC approved spot ETFs in January 2024), or its brand. Ethereum is a competitor for programmable uses. Bitcoin's niche is \"digital gold\": the store of value, not the compute platform."
    },
    {
      "type": "prose",
      "label": "Recent Snapshot",
      "body": "Spot ETFs are live in the US and have accumulated tens of billions since approval. Institutional buyers (BlackRock, Fidelity, sovereign wealth funds) now hold Bitcoin through regulated vehicles. The April 2024 halving cut new supply issuance in half, per the protocol's built-in schedule. Historically, Bitcoin rallies 12-18 months after each halving as the supply shock plays out. This cycle either rhymes with history or breaks the pattern.\n\nLive price and market cap are pulled from the price service at read time."
    },
    {
      "type": "bull_bear",
      "label": "Bull vs Bear",
      "bull": [
        {"title": "Fixed supply versus infinite fiat.", "body": "As long as central banks expand money supply, there is a case for owning a provably scarce asset. Bitcoin's supply schedule cannot be changed by any government, committee, or election."},
        {"title": "Institutional adoption is structural.", "body": "BlackRock's spot ETF is one of the fastest-growing ETFs in history. Sovereign wealth funds and corporate treasuries are now allocating. This is not the retail fad of 2017."},
        {"title": "Asymmetric upside.", "body": "If Bitcoin becomes even 1% of global wealth storage, it's multiples higher than today. If it goes to zero, you lose 1x your position. For small sizing, the payoff shape is very attractive."}
      ],
      "bear": [
        {"title": "Volatility is brutal.", "body": "50-70% drawdowns have happened repeatedly and will happen again. Most people sell at the bottom because holding through pain is much harder than they expect. The asset is only good for you if you can actually hold it."},
        {"title": "Regulatory risk is real, just not imminent.", "body": "A hostile administration could restrict self-custody, tax harshly, or constrain mining. Unlikely but not zero. Regulatory risk is highest when a crisis inside crypto spills into the mainstream."},
        {"title": "The \"digital gold\" thesis might be wrong.", "body": "Maybe Bitcoin is just a speculative asset that fades over 20 years. The thesis depends on continued collective belief, which is not a traditional moat. Assets can go to zero."}
      ]
    },
    {
      "type": "prose",
      "label": "Thesis Instead of Management",
      "body": "Bitcoin has no CEO. That's not a bug; it's the entire point. Satoshi Nakamoto disappeared in 2010. Core developers maintain the open-source code but cannot change fundamental rules without network consensus. The absence of a central controller is what makes Bitcoin censorship-resistant and supply-fixed.\n\nYou are not betting on a team. You are betting on an idea and its math. If you believe in that idea and can tolerate the volatility, sizing is your real decision. If you don't believe in the idea, don't own it. No amount of price action will change the underlying thesis."
    },
    {
      "type": "questions",
      "label": "Three Guided Questions",
      "questions": [
        "Druckenmiller's asymmetric-bet rule: \"If you're right you make many multiples. If you're wrong you lose 1x.\" Does Bitcoin fit that shape today, at current price levels? And specifically: what position size lets you survive being wrong without it hurting your life?",
        "Bitcoin has crashed more than 50% multiple times. Write your rules now, before you're in a drawdown: at what percentage loss do you sell? If your answer is \"I wouldn't sell,\" are you sure? What does your past behavior with losing positions suggest?",
        "Critics say Bitcoin is a bubble. Supporters say we're early. Both can't be right forever. What specific observable data point, not a feeling, would change your view in the next 12 months?"
      ]
    }
  ]
}
$json$::jsonb)

ON CONFLICT (slug) DO UPDATE SET
  symbol                 = EXCLUDED.symbol,
  title                  = EXCLUDED.title,
  difficulty             = EXCLUDED.difficulty,
  linked_playbooks       = EXCLUDED.linked_playbooks,
  estimated_read_minutes = EXCLUDED.estimated_read_minutes,
  body                   = EXCLUDED.body,
  author                 = EXCLUDED.author,
  updated_at             = now();
