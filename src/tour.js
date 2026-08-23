// Wrapper around the original boot-tour module. The parameter UI is installed
// here because index.html already imports this module before renderer startup,
// letting the feature remain self-contained and keeping the page markup stable.
import { installModelParameterControls } from './model-params.js';
export * from './tour-core.js';

installModelParameterControls();
