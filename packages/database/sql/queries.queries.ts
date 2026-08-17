/** Types generated for queries found in "sql/queries.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type NumberOrString = number | string;

/** 'InsertKnownToken' parameters type */
export interface IInsertKnownTokenParams {
  kind: string;
  name: string;
  token_color: string;
}

/** 'InsertKnownToken' return type */
export type IInsertKnownTokenResult = void;

/** 'InsertKnownToken' query type */
export interface IInsertKnownTokenQuery {
  params: IInsertKnownTokenParams;
  result: IInsertKnownTokenResult;
}

const insertKnownTokenIR: any = {"usedParamSet":{"token_color":true,"name":true,"kind":true},"params":[{"name":"token_color","required":true,"transform":{"type":"scalar"},"locs":[{"a":59,"b":71}]},{"name":"name","required":true,"transform":{"type":"scalar"},"locs":[{"a":74,"b":79}]},{"name":"kind","required":true,"transform":{"type":"scalar"},"locs":[{"a":82,"b":87}]}],"statement":"INSERT INTO known_tokens (token_color, name, kind)\nVALUES (:token_color!, :name!, :kind!)\nON CONFLICT (token_color) DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO known_tokens (token_color, name, kind)
 * VALUES (:token_color!, :name!, :kind!)
 * ON CONFLICT (token_color) DO NOTHING
 * ```
 */
export const insertKnownToken = new PreparedQuery<IInsertKnownTokenParams,IInsertKnownTokenResult>(insertKnownTokenIR);


/** 'GetKnownTokens' parameters type */
export type IGetKnownTokensParams = void;

/** 'GetKnownTokens' return type */
export interface IGetKnownTokensResult {
  id: number;
  kind: string;
  name: string;
  token_color: string;
}

/** 'GetKnownTokens' query type */
export interface IGetKnownTokensQuery {
  params: IGetKnownTokensParams;
  result: IGetKnownTokensResult;
}

const getKnownTokensIR: any = {"usedParamSet":{},"params":[],"statement":"SELECT * FROM known_tokens"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM known_tokens
 * ```
 */
export const getKnownTokens = new PreparedQuery<IGetKnownTokensParams,IGetKnownTokensResult>(getKnownTokensIR);


/** 'InsertOfferFileNullifier' parameters type */
export interface IInsertOfferFileNullifierParams {
  nullifier: string;
  offer_file_id: number;
}

/** 'InsertOfferFileNullifier' return type */
export type IInsertOfferFileNullifierResult = void;

/** 'InsertOfferFileNullifier' query type */
export interface IInsertOfferFileNullifierQuery {
  params: IInsertOfferFileNullifierParams;
  result: IInsertOfferFileNullifierResult;
}

const insertOfferFileNullifierIR: any = {"usedParamSet":{"offer_file_id":true,"nullifier":true},"params":[{"name":"offer_file_id","required":true,"transform":{"type":"scalar"},"locs":[{"a":84,"b":98}]},{"name":"nullifier","required":true,"transform":{"type":"scalar"},"locs":[{"a":105,"b":115}]}],"statement":"INSERT INTO offer_file_nullifiers (\n    offer_file_id,\n    nullifier\n) VALUES (\n    :offer_file_id!,\n    :nullifier!\n) ON CONFLICT (offer_file_id, nullifier) DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO offer_file_nullifiers (
 *     offer_file_id,
 *     nullifier
 * ) VALUES (
 *     :offer_file_id!,
 *     :nullifier!
 * ) ON CONFLICT (offer_file_id, nullifier) DO NOTHING
 * ```
 */
export const insertOfferFileNullifier = new PreparedQuery<IInsertOfferFileNullifierParams,IInsertOfferFileNullifierResult>(insertOfferFileNullifierIR);


/** 'InsertOfferFileUnshieldedSpend' parameters type */
export interface IInsertOfferFileUnshieldedSpendParams {
  intent_hash: string;
  offer_file_id: number;
  output_no: number;
  owner: string;
}

/** 'InsertOfferFileUnshieldedSpend' return type */
export type IInsertOfferFileUnshieldedSpendResult = void;

/** 'InsertOfferFileUnshieldedSpend' query type */
export interface IInsertOfferFileUnshieldedSpendQuery {
  params: IInsertOfferFileUnshieldedSpendParams;
  result: IInsertOfferFileUnshieldedSpendResult;
}

const insertOfferFileUnshieldedSpendIR: any = {"usedParamSet":{"offer_file_id":true,"owner":true,"intent_hash":true,"output_no":true},"params":[{"name":"offer_file_id","required":true,"transform":{"type":"scalar"},"locs":[{"a":119,"b":133}]},{"name":"owner","required":true,"transform":{"type":"scalar"},"locs":[{"a":140,"b":146}]},{"name":"intent_hash","required":true,"transform":{"type":"scalar"},"locs":[{"a":153,"b":165}]},{"name":"output_no","required":true,"transform":{"type":"scalar"},"locs":[{"a":172,"b":182}]}],"statement":"INSERT INTO offer_file_unshielded_spends (\n    offer_file_id,\n    owner,\n    intent_hash,\n    output_no\n) VALUES (\n    :offer_file_id!,\n    :owner!,\n    :intent_hash!,\n    :output_no!\n) ON CONFLICT (offer_file_id, owner, intent_hash, output_no) DO NOTHING                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              "};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO offer_file_unshielded_spends (
 *     offer_file_id,
 *     owner,
 *     intent_hash,
 *     output_no
 * ) VALUES (
 *     :offer_file_id!,
 *     :owner!,
 *     :intent_hash!,
 *     :output_no!
 * ) ON CONFLICT (offer_file_id, owner, intent_hash, output_no) DO NOTHING                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              
 * ```
 */
export const insertOfferFileUnshieldedSpend = new PreparedQuery<IInsertOfferFileUnshieldedSpendParams,IInsertOfferFileUnshieldedSpendResult>(insertOfferFileUnshieldedSpendIR);


/** 'MarkNullifierMatched' parameters type */
export interface IMarkNullifierMatchedParams {
  nullifier: string;
}

/** 'MarkNullifierMatched' return type */
export type IMarkNullifierMatchedResult = void;

/** 'MarkNullifierMatched' query type */
export interface IMarkNullifierMatchedQuery {
  params: IMarkNullifierMatchedParams;
  result: IMarkNullifierMatchedResult;
}

const markNullifierMatchedIR: any = {"usedParamSet":{"nullifier":true},"params":[{"name":"nullifier","required":true,"transform":{"type":"scalar"},"locs":[{"a":61,"b":71}]}],"statement":"UPDATE nullifiers SET offer_matched = true WHERE nullifier = :nullifier!"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE nullifiers SET offer_matched = true WHERE nullifier = :nullifier!
 * ```
 */
export const markNullifierMatched = new PreparedQuery<IMarkNullifierMatchedParams,IMarkNullifierMatchedResult>(markNullifierMatchedIR);


/** 'FindUnmatchedNullifier' parameters type */
export interface IFindUnmatchedNullifierParams {
  nullifier: string;
}

/** 'FindUnmatchedNullifier' return type */
export interface IFindUnmatchedNullifierResult {
  height: string;
  nullifier: string;
}

/** 'FindUnmatchedNullifier' query type */
export interface IFindUnmatchedNullifierQuery {
  params: IFindUnmatchedNullifierParams;
  result: IFindUnmatchedNullifierResult;
}

const findUnmatchedNullifierIR: any = {"usedParamSet":{"nullifier":true},"params":[{"name":"nullifier","required":true,"transform":{"type":"scalar"},"locs":[{"a":59,"b":69}]}],"statement":"SELECT nullifier, height FROM nullifiers\nWHERE nullifier = :nullifier! AND offer_matched = false"};

/**
 * Query generated from SQL:
 * ```
 * SELECT nullifier, height FROM nullifiers
 * WHERE nullifier = :nullifier! AND offer_matched = false
 * ```
 */
export const findUnmatchedNullifier = new PreparedQuery<IFindUnmatchedNullifierParams,IFindUnmatchedNullifierResult>(findUnmatchedNullifierIR);


/** 'IsNullifierSpent' parameters type */
export interface IIsNullifierSpentParams {
  nullifier: string;
}

/** 'IsNullifierSpent' return type */
export interface IIsNullifierSpentResult {
  spent: number | null;
}

/** 'IsNullifierSpent' query type */
export interface IIsNullifierSpentQuery {
  params: IIsNullifierSpentParams;
  result: IIsNullifierSpentResult;
}

const isNullifierSpentIR: any = {"usedParamSet":{"nullifier":true},"params":[{"name":"nullifier","required":true,"transform":{"type":"scalar"},"locs":[{"a":52,"b":62}]}],"statement":"SELECT 1 AS spent FROM nullifiers WHERE nullifier = :nullifier!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS spent FROM nullifiers WHERE nullifier = :nullifier!
 * ```
 */
export const isNullifierSpent = new PreparedQuery<IIsNullifierSpentParams,IIsNullifierSpentResult>(isNullifierSpentIR);


/** 'InsertCreatedUnshielded' parameters type */
export interface IInsertCreatedUnshieldedParams {
  height: NumberOrString;
  intent_hash: string;
  output_no: number;
  owner: string;
}

/** 'InsertCreatedUnshielded' return type */
export type IInsertCreatedUnshieldedResult = void;

/** 'InsertCreatedUnshielded' query type */
export interface IInsertCreatedUnshieldedQuery {
  params: IInsertCreatedUnshieldedParams;
  result: IInsertCreatedUnshieldedResult;
}

const insertCreatedUnshieldedIR: any = {"usedParamSet":{"owner":true,"intent_hash":true,"output_no":true,"height":true},"params":[{"name":"owner","required":true,"transform":{"type":"scalar"},"locs":[{"a":79,"b":85}]},{"name":"intent_hash","required":true,"transform":{"type":"scalar"},"locs":[{"a":88,"b":100}]},{"name":"output_no","required":true,"transform":{"type":"scalar"},"locs":[{"a":103,"b":113}]},{"name":"height","required":true,"transform":{"type":"scalar"},"locs":[{"a":116,"b":123}]}],"statement":"INSERT INTO created_unshielded (owner, intent_hash, output_no, height)\nVALUES (:owner!, :intent_hash!, :output_no!, :height!)\nON CONFLICT (owner, intent_hash, output_no) DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO created_unshielded (owner, intent_hash, output_no, height)
 * VALUES (:owner!, :intent_hash!, :output_no!, :height!)
 * ON CONFLICT (owner, intent_hash, output_no) DO NOTHING
 * ```
 */
export const insertCreatedUnshielded = new PreparedQuery<IInsertCreatedUnshieldedParams,IInsertCreatedUnshieldedResult>(insertCreatedUnshieldedIR);


/** 'DeleteCreatedUnshielded' parameters type */
export interface IDeleteCreatedUnshieldedParams {
  intent_hash: string;
  output_no: number;
  owner: string;
}

/** 'DeleteCreatedUnshielded' return type */
export type IDeleteCreatedUnshieldedResult = void;

/** 'DeleteCreatedUnshielded' query type */
export interface IDeleteCreatedUnshieldedQuery {
  params: IDeleteCreatedUnshieldedParams;
  result: IDeleteCreatedUnshieldedResult;
}

const deleteCreatedUnshieldedIR: any = {"usedParamSet":{"owner":true,"intent_hash":true,"output_no":true},"params":[{"name":"owner","required":true,"transform":{"type":"scalar"},"locs":[{"a":45,"b":51}]},{"name":"intent_hash","required":true,"transform":{"type":"scalar"},"locs":[{"a":73,"b":85}]},{"name":"output_no","required":true,"transform":{"type":"scalar"},"locs":[{"a":105,"b":115}]}],"statement":"DELETE FROM created_unshielded\nWHERE owner = :owner!\n  AND intent_hash = :intent_hash!\n  AND output_no = :output_no!"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM created_unshielded
 * WHERE owner = :owner!
 *   AND intent_hash = :intent_hash!
 *   AND output_no = :output_no!
 * ```
 */
export const deleteCreatedUnshielded = new PreparedQuery<IDeleteCreatedUnshieldedParams,IDeleteCreatedUnshieldedResult>(deleteCreatedUnshieldedIR);


/** 'IsUnshieldedCreated' parameters type */
export interface IIsUnshieldedCreatedParams {
  intent_hash: string;
  output_no: number;
  owner: string;
}

/** 'IsUnshieldedCreated' return type */
export interface IIsUnshieldedCreatedResult {
  present: number | null;
}

/** 'IsUnshieldedCreated' query type */
export interface IIsUnshieldedCreatedQuery {
  params: IIsUnshieldedCreatedParams;
  result: IIsUnshieldedCreatedResult;
}

const isUnshieldedCreatedIR: any = {"usedParamSet":{"owner":true,"intent_hash":true,"output_no":true},"params":[{"name":"owner","required":true,"transform":{"type":"scalar"},"locs":[{"a":58,"b":64}]},{"name":"intent_hash","required":true,"transform":{"type":"scalar"},"locs":[{"a":86,"b":98}]},{"name":"output_no","required":true,"transform":{"type":"scalar"},"locs":[{"a":118,"b":128}]}],"statement":"SELECT 1 AS present\nFROM created_unshielded\nWHERE owner = :owner!\n  AND intent_hash = :intent_hash!\n  AND output_no = :output_no!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT 1 AS present
 * FROM created_unshielded
 * WHERE owner = :owner!
 *   AND intent_hash = :intent_hash!
 *   AND output_no = :output_no!
 * ```
 */
export const isUnshieldedCreated = new PreparedQuery<IIsUnshieldedCreatedParams,IIsUnshieldedCreatedResult>(isUnshieldedCreatedIR);


/** 'PruneKnownRoots' parameters type */
export interface IPruneKnownRootsParams {
  cutoff_ms: NumberOrString;
}

/** 'PruneKnownRoots' return type */
export type IPruneKnownRootsResult = void;

/** 'PruneKnownRoots' query type */
export interface IPruneKnownRootsQuery {
  params: IPruneKnownRootsParams;
  result: IPruneKnownRootsResult;
}

const pruneKnownRootsIR: any = {"usedParamSet":{"cutoff_ms":true},"params":[{"name":"cutoff_ms","required":true,"transform":{"type":"scalar"},"locs":[{"a":244,"b":254}]}],"statement":"-- Drop roots older than the window cutoff, but never the most recent root: on\n-- a quiet chain the latest root keeps being re-accepted, mirroring the\n-- ledger's past_roots re-insertion each block.\nDELETE FROM known_roots\nWHERE last_seen_ms < :cutoff_ms!\n  AND height < (SELECT MAX(height) FROM known_roots)"};

/**
 * Query generated from SQL:
 * ```
 * -- Drop roots older than the window cutoff, but never the most recent root: on
 * -- a quiet chain the latest root keeps being re-accepted, mirroring the
 * -- ledger's past_roots re-insertion each block.
 * DELETE FROM known_roots
 * WHERE last_seen_ms < :cutoff_ms!
 *   AND height < (SELECT MAX(height) FROM known_roots)
 * ```
 */
export const pruneKnownRoots = new PreparedQuery<IPruneKnownRootsParams,IPruneKnownRootsResult>(pruneKnownRootsIR);


