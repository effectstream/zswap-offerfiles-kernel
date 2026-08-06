-- Unshielded fill-vs-cancel: the evidence the shielded path already has.
--
-- Every consumption of an unshielded-only offer classified `consumed`, because
-- nothing recorded WHICH transaction spent an unshielded UTXO. All three
-- branches of cancelledPredicate were therefore dead on that layer — not
-- merely inaccurate, unable to fire at all. A maker who spent their own UTXO on
-- themselves was recorded as a completed sale, moving chart history, volume,
-- last_price and trade_count for the cost of one self-transfer.
--
-- No new capability was needed. The `midnight-unshielded-spend` and
-- `midnight-unshielded-create` primitives already deliver `txHash`, `value` and
-- `tokenType` (see their grammars in @effectstream/sm); the state machine was
-- discarding them. These tables are where they land, mirroring the shielded
-- side one-for-one:
--
--   nullifiers              <->  unshielded_spends        (permanent, tx-keyed)
--   commitments             <->  unshielded_creates       (permanent, tx-keyed)
--   offer_file_commitments  <->  offer_file_unshielded_outputs  (the offer's markers)

-- Every unshielded spend observed on chain, kept FOREVER, for the same reason
-- `nullifiers` is: a spend never becomes un-spent, and this is the record
-- read-time classification consults. Distinct from `created_unshielded`, which
-- is a LIVE-set that deletes on spend and answers a different question ("can
-- this offer still settle"). Classification needs the opposite — what was
-- consumed, and by which transaction.
CREATE TABLE IF NOT EXISTS unshielded_spends (
    owner       TEXT    NOT NULL,
    intent_hash TEXT    NOT NULL,
    output_no   INTEGER NOT NULL,
    tx_hash     TEXT,                -- the SPENDING transaction — the discriminator
    height      BIGINT  NOT NULL,
    PRIMARY KEY (owner, intent_hash, output_no)
);
-- Classification asks "which spends did tx T perform".
CREATE INDEX IF NOT EXISTS idx_unshielded_spends_tx_hash ON unshielded_spends (tx_hash);

-- Every unshielded UTXO created on chain, kept forever — the unshielded
-- analogue of `commitments`. `created_unshielded` cannot serve this purpose:
-- it deletes the row when the UTXO is later spent, which would retroactively
-- erase the evidence that a settlement ever happened and silently reclassify a
-- historical fill as a cancel.
CREATE TABLE IF NOT EXISTS unshielded_creates (
    owner       TEXT    NOT NULL,
    intent_hash TEXT    NOT NULL,
    output_no   INTEGER NOT NULL,
    tx_hash     TEXT,                -- the CREATING transaction
    token_type  TEXT    NOT NULL,    -- hex serialized token type
    value       TEXT    NOT NULL,    -- u128 as decimal string
    height      BIGINT  NOT NULL,
    PRIMARY KEY (owner, intent_hash, output_no)
);
-- The fill-marker match is "did tx T create a UTXO paying <owner, type, value>".
CREATE INDEX IF NOT EXISTS idx_unshielded_creates_marker
    ON unshielded_creates (tx_hash, owner, token_type, value);

-- The offer's OWN declared unshielded outputs — its fill markers, the
-- unshielded counterpart of offer_file_commitments. A settling transaction must
-- create every one of them; a maker walking away creates none.
--
-- Matched on (owner, token_type, value) rather than on the intent hash and
-- output index, because those belong to the SETTLING intent and the maker
-- cannot know them when publishing. Amounts are exact: the offer fixes what the
-- maker is owed, and merging preserves outputs verbatim.
CREATE TABLE IF NOT EXISTS offer_file_unshielded_outputs (
    offer_file_id INTEGER NOT NULL REFERENCES offer_file(id) ON DELETE CASCADE,
    owner         TEXT    NOT NULL,
    token_type    TEXT    NOT NULL,
    value         TEXT    NOT NULL,
    PRIMARY KEY (offer_file_id, owner, token_type, value)
);

CREATE TABLE IF NOT EXISTS offer_file_unshielded_outputs_history (
    offer_file_id INTEGER NOT NULL,
    owner         TEXT    NOT NULL,
    token_type    TEXT    NOT NULL,
    value         TEXT    NOT NULL,
    PRIMARY KEY (offer_file_id, owner, token_type, value)
);

-- No tx_hash column on offer_file_unshielded_spends{,_history} on purpose: the
-- predicate joins `unshielded_spends` on the (owner, intent_hash, output_no)
-- triple, which is the same key, so a copy would be dead schema kept in sync
-- for nothing.
