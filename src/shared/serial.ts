/**
 * 작업을 하나씩 차례로 실행하는 줄을 만든다. 저장소 값을 읽고 고쳐 쓰는 작업이 겹쳐 값을 잃지 않게 한다.
 * 앞 작업이 실패해도 다음 작업은 실행한다.
 */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
}
