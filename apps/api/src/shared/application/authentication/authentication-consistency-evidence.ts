import type { AuthenticationLedgerHead } from './authentication-maintenance-ports.js';

declare const consistencyEvidenceBrand: unique symbol;

/** 証跡Adapterのregistryだけが発行・解決する、単回使用の不透明handle。 */
export type AuthenticationConsistencyEvidenceHandle = object & {
  /** 構造的な偽造や別registryのhandleを型でも区別する。 */
  readonly [consistencyEvidenceBrand]: true;
};

/** 証跡を束縛する入力。鍵、Invitation本文、Actor IDを渡さない。 */
export interface AuthenticationConsistencyBinding {
  /** 外部fenceを所有するRestore run UUIDv4。 */
  readonly runId: string;
  /** 信頼済みBackup catalogが全Contextで共通に発行した復旧点UUIDv4。 */
  readonly recoveryPointId: string;
  /** 呼出し時点で検証済みの認証Ledger head。 */
  readonly head: AuthenticationLedgerHead;
}

/** registryが単回消費で返す、検証済み証跡の独立Copy。 */
export interface AuthenticationConsistencyEvidence {
  /** 証跡が覆う復旧点。bindingと一致する。 */
  readonly recoveryPointId: string;
  /** 検証済みContext名。重複なし、UTF-8 byte順の昇順。 */
  readonly contexts: readonly string[];
  /**
   * 各Contextの検証済み状態（復旧点に束縛したhead revisionを含む）を覆う32-byte値。
   * MAC等では認証されず、真正性は証跡Providerへの信頼に依る。
   */
  readonly consistencyDigest: Uint8Array;
}

/** Restoreが全Context整合を要求する、認証側所有のconsumer Port。 */
export interface AuthenticationConsistencyEvidencePort {
  /**
   * 復旧点と認証Ledger headについて全Contextの整合を検証し、handleを発行する。
   * @param binding run、復旧点、検証済みhead。
   * @returns この呼出しのbindingにだけ使える未消費handle。
   * @throws 証跡の不足、複数一致、復旧点の不一致、Provider障害。成功扱いにしない。
   */
  verify(
    binding: AuthenticationConsistencyBinding,
  ): Promise<AuthenticationConsistencyEvidenceHandle>;
  /**
   * 同じregistryが発行した未消費handleを、bindingとの一致を確認して消費する。
   * @param handle `verify`が返したhandle。
   * @param binding `verify`へ渡したものと同じbinding。
   * @returns 検証済み証跡の独立Copy。
   * @throws 偽造、別registry、別binding、消費済みの場合。
   */
  consume(
    handle: AuthenticationConsistencyEvidenceHandle,
    binding: AuthenticationConsistencyBinding,
  ): AuthenticationConsistencyEvidence;
}

/** recovery checkpointへappendする`evidenceDigest`の構成要素。 */
export interface AuthenticationRestoreEvidenceInput {
  /** `migrateIdentity`が返した認証の移行fingerprint digest（32-byte）。 */
  readonly fingerprint: Uint8Array;
  /** コード破棄closureと0-rowの検証結果digest。コード不参加はnull。 */
  readonly codeClosure: Uint8Array | null;
  /** P2で検証した整合証跡。証跡を要求しない構成はnull。 */
  readonly consistency: AuthenticationConsistencyEvidence | null;
}

/** `evidenceDigest`の固定書式とSHA-256を担うPort。暗号実装はInfrastructureに置く。 */
export interface AuthenticationRestoreEvidenceDigest {
  /**
   * ADR #278 論点3の固定順序・長さ前置書式で`evidenceDigest`を計算する。
   * @param input fingerprint、コード参加、整合証跡。
   * @returns 32-byte値。
   * @throws AuthenticationCryptoUnavailable 長さやContext名が不正な場合。
   */
  digest(input: AuthenticationRestoreEvidenceInput): Uint8Array;
}
