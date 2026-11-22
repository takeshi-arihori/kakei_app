import { PublicGraphQLError } from '../../../presentation/graphql/public-graphql-error.js';
import { GroupCommandApplicationError } from '../../application/group-command-service.js';

/**
 * Group ManagementのApplication Errorを公開Errorへ写像する唯一のModule（#304 §5、#305 §1・§2）。
 * 公開するのはClientが行動を変えられる`OPERATION_MISMATCH`だけで、障害・内部の不整合
 * （`GROUP_ALREADY_EXISTS`を含む）と想定外例外は`SERVICE_UNAVAILABLE`へmaskする。
 * 原因例外・入力値・IDは公開Errorへ引き継がない。
 * @param error Use Caseまたは入出力変換から届いた未検証の例外。
 * @returns 許可Listのcodeだけを持つ公開Error。
 */
export const toPublicGroupError = (error: unknown): PublicGraphQLError =>
  error instanceof GroupCommandApplicationError &&
  error.code === 'OPERATION_MISMATCH'
    ? new PublicGraphQLError('OPERATION_MISMATCH')
    : new PublicGraphQLError('SERVICE_UNAVAILABLE');
