// Adapter that subscribes the ai-elements <Reasoning> primitive to Studio's
// chat-event bus rather than the @ai-sdk/react `useChat` hook. The server's
// `chat:reasoning` envelope (emitted by `thinkParser.ts`) feeds this panel
// independently from the regular `chat:chunk` content stream.
//
// Two render paths:
// * `streamingMsgId` — live tail of the bus while the model is thinking. Text
//   accumulates locally; the panel auto-opens during streaming and collapses
//   shortly after.
// * `text` — historic value. Used when re-rendering a persisted assistant
//   message that already carries a `{ type: 'reasoning' }` part.

import { useEffect, useState } from 'react';
import {
  Reasoning as AiReasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '../ai-elements/reasoning';
import { chatEvents } from '../../services/chatEvents';

interface StreamingProps {
  streamingMsgId: string;
  text?: never;
}
interface HistoricProps {
  streamingMsgId?: never;
  text: string;
}
type Props = StreamingProps | HistoricProps;

export default function Reasoning(props: Props): JSX.Element | null {
  const [streamed, setStreamed] = useState('');
  const isStreaming = !!props.streamingMsgId;

  useEffect(() => {
    if (!props.streamingMsgId) return undefined;
    setStreamed('');
    const off = chatEvents.onReasoning(({ msgId, delta }) => {
      if (msgId !== props.streamingMsgId) return;
      setStreamed(prev => prev + delta);
    });
    return off;
  }, [props.streamingMsgId]);

  const text = isStreaming ? streamed : (props.text ?? '');
  // No reasoning produced for this turn — stay invisible so non-thinking
  // models render normally without a stray "Thinking..." chip.
  if (!isStreaming && text.length === 0) return null;

  return (
    <AiReasoning className="mb-2" isStreaming={isStreaming}>
      <ReasoningTrigger />
      <ReasoningContent>{text}</ReasoningContent>
    </AiReasoning>
  );
}
