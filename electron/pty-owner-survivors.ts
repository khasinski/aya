// The shared B2 process-instance policy. Main may use it only after owner
// retirement and separate survivor consent; no helper JS host is needed.
import {ownerProcessGroupExists,ownerRecoverySupported,snapshotOwnerRecoveryMembersAsync,recoverOwnerProcess,ownerGroupMemberPidsAsync,type OwnerPane} from "./pty-owner-client";
import type {OwnerRecord} from "./pty-owner-registry";
export interface OwnerSurvivorState {
  record:OwnerRecord;inventory:Map<string,OwnerPane>;disconnected:Map<string,OwnerPane>;persist():void;
}
export async function settleOwnerSurvivors(state:OwnerSurvivorState,orderlyExit:boolean,allowSignals=true):Promise<void>{
  const {record,inventory,disconnected}=state;
    const refused: string[] = [];
    for (const pane of [...inventory.values()]) {
      try {
        if (ownerProcessGroupExists(pane.pid)) {
          if(!allowSignals)throw new Error("surviving processes need a separate confirmation");
          if (!ownerRecoverySupported()) throw new Error("this kernel/process environment does not support process-instance-safe recovery; its listed processes were not stopped");
          if (!pane.startIdentity) throw new Error("its kernel start identity was not recorded");
          if (!pane.recoveryMembers) {
            pane.recoveryMembers = await snapshotOwnerRecoveryMembersAsync(pane.pid, pane.startIdentity);
            // Persist the exact members before the first signal: a partially
            // completed recovery must not invent new targets on retry.
            state.persist();
          }
          const failures: string[] = [];
          for (const member of pane.recoveryMembers) {
            const outcome = recoverOwnerProcess(member, pane.pid);
            if (outcome !== "signalled" && outcome !== "absent") failures.push(`PID ${member.pid}: ${outcome}`);
          }
          const deadline = Date.now() + 5000;
          while (ownerProcessGroupExists(pane.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
          const left = await ownerGroupMemberPidsAsync(pane.pid);
          if (left.length) failures.push(`group members still present or unverified: ${left.join(", ")}`);
          if (failures.length) throw new Error(failures.join("; "));
        }
        inventory.delete(pane.id); disconnected.delete(pane.id);
      } catch (error) { refused.push(`${pane.id} (PID ${pane.pid}): ${error instanceof Error ? error.message : String(error)}`.slice(0, 500)); }
    }
    if (orderlyExit) { record.uncertain = []; record.spawnIntents = []; }
    for (const id of new Set([...(record.uncertain??[]),...(record.spawnIntents??[]).map(p=>p.id)])) refused.push(`${id}: its spawn was not acknowledged and no process identity can be verified`);
    record.recoveryFailures = refused;
    state.persist();
    if (refused.length) throw new Error(`Not stopped; their inventory was kept:\n${refused.join("\n")}`);

}
