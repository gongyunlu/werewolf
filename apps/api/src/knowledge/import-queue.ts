export const KNOWLEDGE_IMPORT_QUEUE = 'knowledge-import';
export interface KnowledgeImportJob {
  captureId: string;
  operation: 'capture' | 'organize';
}
export const importJobId = (id: string, operation: KnowledgeImportJob['operation']) =>
  `${operation}-${id}`;
