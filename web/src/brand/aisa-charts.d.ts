// Types for the vendored AIsa charts module (plain JS). Configs are documented in aisa-charts.js.
export interface ChartHandle { update(config: Record<string, unknown>): void; destroy(): void }
type Mount = (host: HTMLElement, config: Record<string, unknown>) => ChartHandle;
export const barChart: Mount;
export const lineChart: Mount;
export const donutChart: Mount;
export const heatmap: Mount;
export const statTile: Mount;
export const meter: Mount;
export const ringGauge: Mount;
export const waffleChart: Mount;
export const funnelChart: Mount;
export const rankList: Mount;
export const slopeChart: Mount;
export const segmentBar: Mount;
export const divergingBar: Mount;
export const calendarHeatmap: Mount;
export const ganttChart: Mount;
export const progressList: Mount;
export const histogram: Mount;
export function setMessages(locale: string, messages: Record<string, string>): void;
