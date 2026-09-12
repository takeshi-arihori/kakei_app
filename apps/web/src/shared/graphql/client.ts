import type { ApiStatusQuery } from './generated.js';
import { API_STATUS_DOCUMENT } from './operations.js';

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ApiGraphQLError extends Error {
  constructor(readonly messages: string[]) {
    super(messages.join('; '));
    this.name = 'ApiGraphQLError';
  }
}

export class ApiTransportError extends Error {
  constructor(cause?: unknown) {
    super('GraphQL API request failed', { cause });
    this.name = 'ApiTransportError';
  }
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: UnknownRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const invalidGraphQLResponse = () =>
  new ApiTransportError(new Error('Invalid GraphQL response'));

const parseApiStatus = (payload: unknown): ApiStatusQuery['apiStatus'] => {
  if (!isRecord(payload)) {
    throw invalidGraphQLResponse();
  }

  if (hasOwn(payload, 'errors')) {
    const { errors } = payload;
    if (!Array.isArray(errors) || !errors.every(isRecord)) {
      throw invalidGraphQLResponse();
    }

    if (errors.length > 0) {
      throw new ApiGraphQLError(
        errors.map(({ message }) =>
          typeof message === 'string' ? message : 'Unknown GraphQL error',
        ),
      );
    }
  }

  const { data } = payload;
  if (!isRecord(data) || !isRecord(data.apiStatus)) {
    throw invalidGraphQLResponse();
  }

  const { status } = data.apiStatus;
  if (typeof status !== 'string') {
    throw invalidGraphQLResponse();
  }

  return { status };
};

export const executeApiStatus = async (
  endpoint: string,
  fetchImpl: FetchLike = fetch,
): Promise<ApiStatusQuery['apiStatus']> => {
  let response: Response;

  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: API_STATUS_DOCUMENT }),
    });
  } catch (cause) {
    throw new ApiTransportError(cause);
  }

  if (!response.ok) {
    throw new ApiTransportError(new Error(`HTTP ${response.status}`));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new ApiTransportError(cause);
  }

  return parseApiStatus(payload);
};
