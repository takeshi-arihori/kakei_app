"use client";
import { useRouter } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { createAuthenticationClient } from '../../src/features/authentication/authentication-client';
import { CreateGroupPanel } from '../../src/features/groups/components/create-group-panel';
import { createGroupClient } from '../../src/features/groups/graphql/create-group-client';
import { GroupCreationController } from '../../src/features/groups/group-creation-controller';

/**
 * 作成操作をBrowserの能力（`/auth/session`のCSRF、同一Origin`/graphql`、乱数、Router）へ接続する。
 * Server Actionsは使わない（#304 §4）。
 * @returns グループ作成の操作領域。成功後はServer Componentの一覧を取り直す。
 */
export function CreateGroupSection() {
  const router = useRouter();
  const [controller] = useState(() => {
    const authentication = createAuthenticationClient();
    return new GroupCreationController({
      inspectSession: () => authentication.inspect(),
      client: createGroupClient(),
      newOperationId: () => crypto.randomUUID(),
      onCreated: () => router.refresh(),
      onAuthenticationRequired: () => window.location.assign('/login'),
    });
  });
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  return <CreateGroupPanel state={state} onSubmit={() => void controller.submit()} />;
}
