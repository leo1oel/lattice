/** The canvas's fixed handle on the review: the editor's keys reach the open card through it. */
export type AnnotationReviewBridge = {
  accept: () => boolean;
  dismiss: () => boolean;
  connect: (handlers: { accept: () => boolean; dismiss: () => boolean }) => () => void;
};

export function createAnnotationReviewBridge(): AnnotationReviewBridge {
  let connected: { accept: () => boolean; dismiss: () => boolean } | null = null;
  return {
    accept: () => connected?.accept() ?? false,
    dismiss: () => connected?.dismiss() ?? false,
    connect: (handlers) => {
      connected = handlers;
      return () => {
        if (connected === handlers) connected = null;
      };
    },
  };
}
