export interface NoteAction {
  text: string;
  owner: string;
}

export interface NotesDraft {
  summary: string;
  decisions: string[];
  actions: NoteAction[];
  followups: string[];
}

export interface NoteQa {
  ts: string;
  asker?: string;
  question: string;
  answer: string;
  channel: "audio" | "chat";
}
