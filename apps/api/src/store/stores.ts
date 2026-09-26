import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { ActionStore } from './actions';
import type { AgentStore } from './agents';
import type { AskedPromptStore } from './asked';
import type { EventStore } from './events';
import type { GameStore } from './games';
import type { StepStore } from './steps';
import type { ObservationStore } from './observations';
import type { ExperienceStore } from './experiences';

/** 一局要用到的那几份存储，成对交给行动提供者。 */
export interface GameStores {
  /** 这一局的档案：从哪块板子开的、有没有分出胜负。 */
  games: GameStore;
  /** 参赛者的接入配置。开局按阵容取型号与端点，密钥现读。 */
  agents: AgentStore;
  experiences: ExperienceStore;
  events: EventStore;
  actions: ActionStore;
  steps: StepStore;
  /** 每次真发出去的提问，发之前先落一份。 */
  asked: AskedPromptStore;
  observations: ObservationStore;
  /** 行动图走到一半的执行进度，答完那一问就没人再看它。 */
  checkpoints: BaseCheckpointSaver;
}
