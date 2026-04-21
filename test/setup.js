const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = (warning, ...args) => {
  const message = typeof warning === 'string' ? warning : warning?.message;

  if (typeof message === 'string' && message.includes('`--localstorage-file` was provided without a valid path')) {
    return;
  }

  return originalEmitWarning(warning, ...args);
};
