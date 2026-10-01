import { writeJson } from '../../utils/output';
import type { TodoItem, TodoTag } from './types';

/** `--json` writes `data`; otherwise `text` prints for people. */
function emit(json: boolean | undefined, data: unknown, text: () => void): void {
  if (json) writeJson(data, 2);
  else text();
}

export function printTodo(todo: TodoItem, json?: boolean): void {
  emit(json, todo, () => {
    const tags = todo.tags.length ? ` [${todo.tags.join(', ')}]` : '';
    const mark = todo.done ? '✓' : '·';
    console.log(`${mark} ${todo.id}  ${todo.title}${tags}`);
  });
}

export function printTodoList(todos: TodoItem[], json?: boolean): void {
  emit(json, { todos }, () => {
    if (todos.length === 0) {
      console.log('(none)');
      return;
    }
    for (const t of todos) printTodo(t, false);
  });
}

export function printTags(tags: TodoTag[], json?: boolean): void {
  emit(json, { tags }, () => {
    if (tags.length === 0) {
      console.log('(none)');
      return;
    }
    for (const t of tags) console.log(`${t.name}  (${t.count})`);
  });
}

export function printDeleted(id: string, json?: boolean): void {
  emit(json, { deleted: id }, () => {
    console.log(`Deleted ${id}`);
  });
}
