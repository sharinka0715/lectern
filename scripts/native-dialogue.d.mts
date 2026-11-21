export interface NativeScenario { id: string; title: string; prompt: string }
export const nativeScenarioIds: readonly string[];
export function selectNativeScenario(suite?: 'native' | 'settings' | 'trust', index?: number, override?: string): NativeScenario;
export function validateNativeAnswer(scenario: NativeScenario, answer: {
  role: string; source: string; status: string; text: string; tools: unknown[];
} | undefined, snapshot?: { status: string; error?: string }): {
  scenarioId: string; checks: string[]; characters: number; source: string; noToolCalls: true;
};
