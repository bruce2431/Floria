import { useEffect, useState } from 'react';
import { checkIsGitClean } from 'src/utils/background/remote/preconditions.js';
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';
import { TeleportStash } from './TeleportStash.js';
export type TeleportLocalErrorType = 'needsGitStash';
type TeleportErrorProps = {
  onComplete: () => void;
  errorsToIgnore?: ReadonlySet<TeleportLocalErrorType>;
};

// Module-level sentinel so the default parameter has stable identity.
// Previously `= new Set()` created a fresh Set every render, which put
// a new object in checkErrors' deps and caused the mount effect to
// re-fire on every render.
const EMPTY_ERRORS_TO_IGNORE: ReadonlySet<TeleportLocalErrorType> = new Set();
export function TeleportError(t0) {
  const {
    onComplete,
    errorsToIgnore: t1
  } = t0;
  const errorsToIgnore = t1 === undefined ? EMPTY_ERRORS_TO_IGNORE : t1;
  const [currentError, setCurrentError] = useState(null);
  useEffect(() => {
    void checkErrors();
  }, [errorsToIgnore, onComplete]);
  const checkErrors = async () => {
    const currentErrors = await getTeleportErrors();
    const filteredErrors = new Set(Array.from(currentErrors).filter(error => !errorsToIgnore.has(error)));
    if (filteredErrors.size === 0) {
      onComplete();
      return;
    }
    if (filteredErrors.has("needsGitStash")) {
      setCurrentError("needsGitStash");
    }
  };
  const handleStashComplete = () => {
    void checkErrors();
  };
  const onCancel = () => {
    gracefulShutdownSync(0);
  };
  if (!currentError) {
    return null;
  }
  switch (currentError) {
    case "needsGitStash":
      {
        return <TeleportStash onStashAndContinue={handleStashComplete} onCancel={onCancel} />;
      }
  }
}
/**
 * Gets current teleport errors that need to be resolved
 * @returns Set of teleport error types that need to be handled
 */
export async function getTeleportErrors(): Promise<Set<TeleportLocalErrorType>> {
  const errors = new Set<TeleportLocalErrorType>();
  const isGitClean = await checkIsGitClean();
  if (!isGitClean) {
    errors.add('needsGitStash');
  }
  return errors;
}
