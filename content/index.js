// content/index.js
import { createAdapter } from './adapters/adapterFactory.js';
import { createTimelineController } from './timeline/timelineController.js';
import { createReviseController } from './revise/reviseController.js';
import { createStore } from './state/store.js';

import { mountActionButtons } from './ui/actionButtons.js';
import { mountDraftReviseButton } from './ui/draftReviseButton.js';
import { createRevisionModal } from './ui/revisionModal.js';

import { buildRevisionPrompt } from './revise/promptBuilder.js';
import { createReviseService } from './revise/reviseService.js';

export function init() {
  const store = createStore({
    activeAnchorId: null,
    timelineData: [],
    reviseConfig: {
      reviseMode: null,
      anthropicApiKey: "",
      anthropicModel: "claude-haiku-4-5",
    },
  });

  const adapter = createAdapter(window.location.hostname);
  if (!adapter) {
    return;
  }

  const timelineController = createTimelineController({
    adapter,
    store,
  });

  const reviseController = createReviseController({
    adapter,
    store,
    promptBuilder: buildRevisionPrompt,
    reviseService: createReviseService(),
    revisionModal: createRevisionModal(),
  });

  mountActionButtons({
    adapter,
    onSavePrompt: (payload) => reviseController.handleSavePrompt(payload),
    onRevisePrompt: (payload) => reviseController.handleMessageRevise(payload),
  });

  mountDraftReviseButton({
    adapter,
    onReviseDraft: (draftText) => reviseController.handleDraftRevise({ draftText }),
  });

  timelineController.start();
}
