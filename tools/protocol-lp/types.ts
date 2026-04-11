/**
 * tools/protocol-lp/types.ts
 *
 * Shared types for Protocol LP Automation.
 */

export type Side = 'sell' | 'buy';
export type PositionStatus = 'active' | 'exhausted' | 'closed';

export interface TrackedPosition {
  pubkey: string;
  side: Side;
  minBinId: number;
  maxBinId: number;
  status: PositionStatus;
  deployedLamports?: number;
  createdAt: number;
}

export interface HarvestRecord {
  timestamp: number;
  positionPubkey: string;
  side: Side;
  amountLamports: number;
  txSig: string;
  binsHarvested: number;
}

export interface DeploymentRecord {
  timestamp: number;
  positionPubkey: string;
  amountLamports: number;
  minBinId: number;
  maxBinId: number;
  activeIdAtDeploy: number;
  txSig: string;
}

export interface ProtocolLPState {
  positions: Record<string, TrackedPosition>;
  harvests: HarvestRecord[];
  deployments: DeploymentRecord[];
  totalSolHarvested: number;
  totalSolDeployed: number;
  cycleCount: number;
}
