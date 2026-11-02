/** 公開Errorへ変換するHTTP拒否。入力値や原因例外を保持しない。 */
export class AuthenticationHttpInputError extends Error {
  /** 入力値や原因例外を含まない、公開拒否への固定status。 */
  readonly status: 400 | 403 | 413 | 415;
  /**
   * @param status 固定のHTTP拒否status。
   */
  constructor(status: 400 | 403 | 413 | 415) {
    super('認証Requestを拒否しました');
    this.status = status;
  }
}
const reject = (status: 400 | 403 | 413 | 415): never => {
  throw new AuthenticationHttpInputError(status);
};

/**
 * Origin/Headerを固定設定へ照合する。Forwarded/Hostは信頼しない。
 * @param request 未検証のRequest。
 * @param origin Compositionで検証済みのcanonical Origin。
 * @param method 許可された唯一のMethod。
 * @throws 前提違反は固定statusだけを保持する拒否。
 */
export const checkAuthenticationRequest = (
  request: Request,
  origin: string,
  method: 'GET' | 'POST',
): void => {
  const h = request.headers;
  if (request.method !== method || h.get('x-kakei-request') !== '1')
    reject(403);
  const from = h.get('origin');
  if ((method === 'POST' || from !== null) && from !== origin) reject(403);
  const site = h.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') reject(403);
  if (
    method === 'GET' &&
    (request.body !== null ||
      (h.get('content-length') !== null && h.get('content-length') !== '0') ||
      h.has('transfer-encoding'))
  )
    reject(400);
};

/** 選択するCookieの名前。Origin/環境による切替はCompositionで固定する。 */
export interface AuthenticationCookieNames {
  /** Browserの試行束縛だけに使う名前。 */
  readonly attempt: string;
  /** 現在Sessionの秘密値だけに使う名前。 */
  readonly session: string;
}
/** Cookie由来の未検証値。本人性として直接使わない。 */
export interface AuthenticationCookieSecrets {
  /** 不在ならundefined。形式の意味は既存Serviceが検査する。 */
  readonly attemptSecret: string | undefined;
  /** 不在ならundefined。Client申告Actorを受け取らない。 */
  readonly sessionSecret: string | undefined;
}
/**
 * 曖昧なCookieの任意選択を避ける。URL decodeや暗黙変換を行わない。
 * @param header Cookie Headerまたは不在。
 * @param names Compositionが固定した2用途の名前。
 * @returns 同名重複のない未検証秘密値。
 * @throws Header上限/制御文字/名前/区切り、選択Cookieの値構文/重複は400。
 */
export const authenticationCookieSecrets = (
  header: string | null,
  names: AuthenticationCookieNames,
): AuthenticationCookieSecrets => {
  if (header !== null && (header.length > 8192 || /[^\x20-\x7e]/.test(header)))
    reject(400);
  const selected = new Map<string, string>();
  for (const segment of header?.split(';') ?? []) {
    const pair = segment.trimStart();
    const separator = pair.indexOf('=');
    if (separator <= 0) reject(400);
    const name = pair.slice(0, separator);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) reject(400);
    // SDK等のCookie値は本人性にも構文判定にも使わない。
    if (name !== names.attempt && name !== names.session) continue;
    const value = pair.slice(separator + 1);
    if (
      !/^(?:[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*|"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*")$/.test(
        value,
      )
    )
      reject(400);
    if (selected.has(name)) reject(400);
    selected.set(name, value);
  }
  return {
    attemptSecret: selected.get(names.attempt),
    sessionSecret: selected.get(names.session),
  };
};

const parseObject = (
  source: string,
  fields: readonly string[],
): Record<string, string> => {
  let index = 0;
  const space = () => {
    while (/[ \t\r\n]/.test(source[index] ?? '') && index < source.length)
      index++;
  };
  const string = (): string => {
    const match =
      // eslint-disable-next-line no-control-regex -- JSON文字列の未escape制御文字を拒否する。
      /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(
        source.slice(index),
      );
    if (!match) return reject(400);
    index += match[0].length;
    return JSON.parse(match[0]) as string;
  };
  space();
  if (source[index++] !== '{') return reject(400);
  space();
  const result: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  if (source[index] !== '}') {
    for (;;) {
      space();
      const key = string();
      if (!fields.includes(key) || Object.hasOwn(result, key))
        return reject(400);
      space();
      if (source[index++] !== ':') return reject(400);
      space();
      result[key] = string();
      space();
      if (source[index] !== ',') break;
      index++;
    }
  }
  if (source[index++] !== '}') return reject(400);
  space();
  if (index !== source.length || Object.keys(result).length !== fields.length)
    return reject(400);
  return result;
};

/**
 * stream上限/期限と重複Fieldを検査してから、許可された文字列Objectだけを復元する。
 * @param request JSONを受け取るPOST Request。
 * @param fields 必須かつ唯一許可するField。空配列なら{}のみ。
 * @returns 未検証の文字列値Object。暗黙変換やprototype setterを使わない。
 * @throws Content-Type/Encoding違反415、超過413、その他の入力/期限違反400。
 */
export const authenticationJsonObject = async (
  request: Request,
  fields: readonly string[],
): Promise<Record<string, string>> => {
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
      request.headers.get('content-type') ?? '',
    ) ||
    (request.headers.has('content-encoding') &&
      request.headers.get('content-encoding') !== 'identity')
  )
    reject(415);
  const length = request.headers.get('content-length');
  if (length !== null && !/^(0|[1-9][0-9]*)$/.test(length)) reject(400);
  if (length !== null && Number(length) > 18_432) reject(413);
  if (request.body === null) reject(400);
  const reader = request.body!.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, rejectTimeout) => {
    timer = setTimeout(() => {
      rejectTimeout(new AuthenticationHttpInputError(400));
      void reader.cancel().catch(() => {});
    }, 5000);
  });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 18_432) reject(413);
      parts.push(part.value);
    }
    if (length !== null && Number(length) !== bytes) reject(400);
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }
    return parseObject(
      new TextDecoder('utf-8', { fatal: true }).decode(data),
      fields,
    );
  } catch (error) {
    if (error instanceof AuthenticationHttpInputError) throw error;
    return reject(400);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
};
