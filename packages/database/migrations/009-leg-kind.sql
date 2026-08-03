-- SHIELDED/UNSHIELDED tags on offer legs (MIP-0006 TokenLeg.type).
--
-- The validator used to merge derived legs by token color, NETTING the same
-- color across value layers — a give of shielded X against a want of
-- unshielded X cancelled out, misstating the offer's actual terms. The MIP
-- is explicit that layers stay separate, and the discovery payload tags
-- every leg. Legs are now stored tagged, and the uniqueness tuple widens so
-- the same color can appear on both layers of the same side.
ALTER TABLE offer_file_tokens
    DROP CONSTRAINT IF EXISTS offer_file_tokens_offer_file_id_token_color_direction_key;
ALTER TABLE offer_file_tokens
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'SHIELDED';
ALTER TABLE offer_file_tokens ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE offer_file_tokens
    ADD CONSTRAINT offer_file_tokens_kind_check CHECK (kind IN ('SHIELDED', 'UNSHIELDED'));
ALTER TABLE offer_file_tokens
    ADD CONSTRAINT offer_file_tokens_unique_leg UNIQUE (offer_file_id, token_color, direction, kind);

ALTER TABLE offer_file_tokens_history
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'SHIELDED';
ALTER TABLE offer_file_tokens_history ALTER COLUMN kind DROP DEFAULT;

-- NOTE for the market queries: a single offer may now carry two rows for the
-- same (color, direction) — one per layer. Queries that pair GIVING×WANTING
-- rows must aggregate by color first or they double-count such offers; the
-- pair/chart queries in sql/queries.app.ts do exactly that.
