import {
  RecipientCodeUnavailable,
  recipientCodeLifetime,
  snapshotRecipientCodeRecord,
  type RecipientCodeRecord,
  type RecipientCodeStoredState,
} from './recipient-code-record.js';

/** AdapterがMAC/Lock/Sessionを検証した判断点の入力。Policy自身は本人認証しない。 */
export interface RecipientCodePolicyFacts {
  /** 発行/取消ではcaller本人、消費では検証済み宛先本人。 */
  readonly actorId: string;
  /** Lock下で再確認した現在のActor有効性。 */
  readonly active: boolean;
  /** 外部fenceと照合した現在epoch。 */
  readonly epoch: string;
  /** 全blocking Lock後に取得するServer UTC milliseconds。 */
  readonly now: number;
}

/** Policyによる保存計画。MACを再計算し、他変更と共通commitするまで未確定。 */
export interface RecipientCodeTransition {
  /** 対象Record。原コードを含まない。 */
  readonly codeId: string;
  /** CASとLock再検証に用いる変更前版。 */
  readonly expectedRecordVersion: number;
  /** 一度だけ進める変更後版。 */
  readonly recordVersion: number;
  /** Issuedへ戻す計画を作らない。 */
  readonly status: Exclude<RecipientCodeStoredState, 'issued'>;
  /** 終端化の判断点。自然期限とは区別する。 */
  readonly terminalAt: number;
}

/** 存在/状態/Actor差を外部へ詳しく公開しない。 */
export interface RecipientCodeRejected {
  /** 再送結果の有無はGM側の別の照合契約で判断する。 */
  readonly status: 'unavailable-to-actor';
}

/** 一Actor一Issuedの置換計画。排他制御・新Record・Audit保存はAdapterが所有する。 */
export type RecipientCodeIssuePlan =
  | RecipientCodeRejected
  | Readonly<{
      /** 計画成功。保存完了や秘密値の表示許可ではない。 */
      status: 'planned';
      /** 新Recordの発行判断点。 */
      createdAt: number;
      /** 新Recordの不変期限。 */
      expiresAt: number;
      /** 旧Issuedだけを終端化する計画。既存終端/不在ならnull。 */
      replaced: RecipientCodeTransition | null;
    }>;

/** 消費は初回のみ。成功再送をここで再消費しない。 */
export type RecipientCodeConsumePlan =
  | RecipientCodeRejected
  | Readonly<{
      /** Invitation作成計画と共通保存を要する終端化。 */
      status: 'consumed';
      /** 新MACとGM証跡なしに単独commitしない。 */
      transition: RecipientCodeTransition;
    }>;

/** 本人取消の冪等な内部判断。外部の存在開示契約は後続設計。 */
export type RecipientCodeRevokePlan =
  | RecipientCodeRejected
  | Readonly<{
      /** 本人認証と保有者照合後の既に無効な対象。 */
      status: 'already-inactive';
    }>
  | Readonly<{
      /** 取消計画であり保存完了ではない。 */
      status: 'revoked';
      /** 他の業務Invitationへ波及させない終端化。 */
      transition: RecipientCodeTransition;
    }>;

const time = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RecipientCodeUnavailable();
  return value;
};
const checkedFacts = (facts: RecipientCodePolicyFacts): void => {
  time(facts.now);
  if (
    typeof facts.active !== 'boolean' ||
    [facts.actorId, facts.epoch].some(
      (value) =>
        typeof value !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          value,
        ),
    )
  )
    throw new RecipientCodeUnavailable();
};
const transition = (
  record: RecipientCodeRecord,
  status: RecipientCodeTransition['status'],
  now: number,
): RecipientCodeTransition => {
  if (!Number.isSafeInteger(record.recordVersion + 1))
    throw new RecipientCodeUnavailable();
  return Object.freeze({
    codeId: record.codeId,
    expectedRecordVersion: record.recordVersion,
    recordVersion: record.recordVersion + 1,
    status,
    terminalAt: now,
  });
};

/**
 * @param createdAt 発行判断点の非負safe integer UTC milliseconds。
 * @returns 延長しない10分後の期限。
 * @throws RecipientCodeUnavailable 不正Clockまたは加算overflow。
 */
export const recipientCodeExpiry = (createdAt: number): number =>
  time(time(createdAt) + recipientCodeLifetime);

/**
 * @param record MAC/Lock検証済みのRecord。構造も再確認する。
 * @param facts Sessionとは別に検証した宛先Actorと判断点。
 * @returns 論理状態または汎用拒否。Session logoutだけの入力は持たない。
 * @throws RecipientCodeUnavailable Metadata/Clockが不正な場合。
 */
export const recipientCodeState = (
  record: RecipientCodeRecord,
  facts: RecipientCodePolicyFacts,
): RecipientCodeStoredState | 'expired' | 'unavailable-to-actor' => {
  const copy = snapshotRecipientCodeRecord(record);
  checkedFacts(facts);
  if (
    !facts.active ||
    facts.actorId !== copy.recipientActorId ||
    facts.epoch !== copy.epoch ||
    facts.now < copy.createdAt
  )
    return 'unavailable-to-actor';
  return copy.status !== 'issued'
    ? copy.status
    : facts.now >= copy.expiresAt
      ? 'expired'
      : 'issued';
};

/**
 * @param previous Actor排他Lock下で選択した唯一の旧Issuedまたは終端Record。不在はnull。
 * @param facts 有効Sessionから得た本人の判断点。Policyは実Sessionを検証しない。
 * @returns 新期限と旧Issued置換の計画、または拒否。入力は変更しない。
 * @throws RecipientCodeUnavailable 不正Metadata/Clockまたは版/時刻overflow。
 */
export const planRecipientCodeIssue = (
  previous: RecipientCodeRecord | null,
  facts: RecipientCodePolicyFacts,
): RecipientCodeIssuePlan => {
  checkedFacts(facts);
  if (!facts.active) return { status: 'unavailable-to-actor' };
  if (
    previous &&
    recipientCodeState(previous, facts) === 'unavailable-to-actor'
  )
    return { status: 'unavailable-to-actor' };
  return Object.freeze({
    status: 'planned',
    createdAt: facts.now,
    expiresAt: recipientCodeExpiry(facts.now),
    replaced:
      previous?.status === 'issued'
        ? transition(previous, 'replaced', facts.now)
        : null,
  });
};

/**
 * @param record 初回作成で使う認証済みコードRecord。
 * @param facts active宛先とLock後Clock。現在Owner/Group判断はGMが別途行う。
 * @returns Issuedだけの消費計画、または拒否。既存成功再送は本関数を通さない。
 * @throws RecipientCodeUnavailable 不正Metadata/Clockまたは版overflow。
 */
export const planRecipientCodeConsume = (
  record: RecipientCodeRecord,
  facts: RecipientCodePolicyFacts,
): RecipientCodeConsumePlan =>
  recipientCodeState(record, facts) === 'issued'
    ? Object.freeze({
        status: 'consumed',
        transition: transition(record, 'consumed', facts.now),
      })
    : { status: 'unavailable-to-actor' };

/**
 * @param record 本人保有を照合したRecord。清掃済み不在だけはnull。
 * @param facts 有効Sessionから得たcaller本人の判断点。
 * @returns 本人Issuedの取消計画、AlreadyInactive、または拒否。Invitationは変更しない。
 * @throws RecipientCodeUnavailable 不正Metadata/Clockまたは版overflow。
 */
export const planRecipientCodeRevoke = (
  record: RecipientCodeRecord | null,
  facts: RecipientCodePolicyFacts,
): RecipientCodeRevokePlan => {
  checkedFacts(facts);
  if (!facts.active) return { status: 'unavailable-to-actor' };
  const state = record ? recipientCodeState(record, facts) : 'expired';
  if (state === 'unavailable-to-actor') return { status: state };
  return state === 'issued' && record
    ? Object.freeze({
        status: 'revoked',
        transition: transition(record, 'revoked', facts.now),
      })
    : { status: 'already-inactive' };
};
