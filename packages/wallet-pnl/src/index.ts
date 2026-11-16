/**
 * Wallet performance from a trade list. Every function here is pure: the same
 * trades give the same answer, and nothing reads the network.
 *
 *   pnl          realized PnL at average cost, win rate, hold time, outcome
 *                bands and a 0-100 smart-money score
 *   copy-score   whether a wallet's record would survive being copied
 *   dust         which small positions are worth closing, counting the rent a
 *                closed token account returns
 */

export * from './pnl';
export * from './copy-score';
export * from './dust';
