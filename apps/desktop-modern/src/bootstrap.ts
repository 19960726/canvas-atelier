import { bootstrapFormalQaDesktopMain } from './formal-qa-network-guard';

bootstrapFormalQaDesktopMain(process.env, {
  loadElectron: () => require('electron'),
  loadMainModule: () => {
    require('./main');
  },
});
