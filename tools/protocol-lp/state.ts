/**
 * tools/protocol-lp/state.ts
 *
 * Persistent state management with atomic writes and mutex.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ProtocolLPState, TrackedPosition, HarvestRecord, DeploymentRecord } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, '..', '..', 'data', 'protocol-lp-state.json');
const MAX_RECORDS = 500;

let state: ProtocolLPState = {
  positions: {},
  harvests: [],
  deployments: [],
  totalSolHarvested: 0,
  totalSolDeployed: 0,
  cycleCount: 0,
};

let writeLock = false;

function ensureDataDir() {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadState(): ProtocolLPState {
  ensureDataDir();
  if (fs.existsSync(STATE_PATH)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    } catch {
      console.warn('Corrupt state file, starting fresh');
      state = { positions: {}, harvests: [], deployments: [], totalSolHarvested: 0, totalSolDeployed: 0, cycleCount: 0 };
    }
  }
  return state;
}

async function saveState(): Promise<void> {
  // Simple mutex — wait if another write is in progress
  while (writeLock) await new Promise(r => setTimeout(r, 50));
  writeLock = true;
  try {
    ensureDataDir();
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } finally {
    writeLock = false;
  }
}

export function getState(): ProtocolLPState {
  return state;
}

export async function setPosition(pubkey: string, pos: TrackedPosition): Promise<void> {
  state.positions[pubkey] = pos;
  await saveState();
}

export async function addHarvest(record: HarvestRecord): Promise<void> {
  state.harvests.push(record);
  if (state.harvests.length > MAX_RECORDS) state.harvests = state.harvests.slice(-MAX_RECORDS);
  state.totalSolHarvested += record.amountLamports;
  await saveState();
}

export async function addDeployment(record: DeploymentRecord): Promise<void> {
  state.deployments.push(record);
  if (state.deployments.length > MAX_RECORDS) state.deployments = state.deployments.slice(-MAX_RECORDS);
  state.totalSolDeployed += record.amountLamports;
  state.cycleCount++;
  await saveState();
}

export async function updatePositionStatus(pubkey: string, status: TrackedPosition['status']): Promise<void> {
  if (state.positions[pubkey]) {
    state.positions[pubkey].status = status;
    await saveState();
  }
}
