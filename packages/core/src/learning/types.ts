export interface LearningPassageRef {
  text: string;
  cfi?: string;
}

export interface LearningSourceRef {
  readAnyBookId: string;
  readAnyChapterId: string;
  location: {
    chapterIndex: number;
    chapterHref?: string;
    cfi?: string;
    passageId?: string;
  };
  title: string;
  text: string;
  passages: LearningPassageRef[];
}

export interface ReadBoxBinding {
  upstreamRef: string;
  readAnyBookId: string;
  readAnyChapterId: string;
  derivedReadBoxBookId: number;
  derivedReadBoxChapterId: number;
  syncVersion: string;
}

export interface LearningCitation {
  sourceType: "BOOK";
  readAnyBookId: string;
  readAnyChapterId: string;
  canonicalLocation: {
    chapterIndex: number;
    chapterHref?: string;
    cfi?: string;
  };
  displayExcerpt: string;
  precision: "PASSAGE" | "CHAPTER";
}

export interface LearningDigest {
  summary: string;
  concepts: Array<{ term: string; explanation: string }>;
  quotes: Array<{ quote: string; reason: string; citation: LearningCitation }>;
}

export interface LearningQuizQuestion {
  type: string;
  question: string;
  options?: string[];
  answer?: string;
  explanation?: string;
}

export interface LearningQuizJudgement {
  correct: boolean;
  explanation: string;
  current: number;
  total: number;
  correctCount: number;
}
