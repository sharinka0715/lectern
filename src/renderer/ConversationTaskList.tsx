import { Check, CircleDashed, CircleEllipsis } from 'lucide-react';
import type { ConversationTask } from '../shared/types';
import './conversation-tasks.css';
import { t } from '../shared/i18n';

const states = {
  completed: { icon: Check, label: 'composer.taskCompleted' },
  in_progress: { icon: CircleEllipsis, label: 'composer.taskInProgress' },
  pending: { icon: CircleDashed, label: 'composer.taskPending' },
} as const;

export function ConversationTaskList({ tasks }: { tasks?: ConversationTask[] }) {
  if (!tasks?.length) return null;
  return <ol className="conversation-tasks" aria-label={t('composer.taskList')}>
    {tasks.map(task => {
      const { icon: Icon, label } = states[task.status];
      return <li key={task.id} data-task-status={task.status}>
        <span className="conversation-task-icon" role="img" aria-label={t(label)} title={t(label)}><Icon size={15} aria-hidden="true" /></span>
        <span>{task.title}</span>
      </li>;
    })}
  </ol>;
}
