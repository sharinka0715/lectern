// Every message namespace. `t('menu.copy')` reads `menu.copy` below.
import { activity } from './activity';
import { app } from './app';
import { artifacts } from './artifacts';
import { backend } from './backend';
import { cards } from './cards';
import { chat } from './chat';
import { composer } from './composer';
import { controller } from './controller';
import { core } from './core';
import { demo } from './demo';
import { dialogs } from './dialogs';
import { files } from './files';
import { hostTools } from './host-tools';
import { main } from './main';
import { menu } from './menu';
import { misc } from './misc';
import { native } from './native';
import { prefs } from './prefs';
import { settings } from './settings';
import { shared } from './shared';
import { sidebar } from './sidebar';
import { telemetry } from './telemetry';
import { update } from './update';
import { workbench } from './workbench';

export const dictionaries = {
  activity,
  app,
  artifacts,
  backend,
  cards,
  chat,
  composer,
  controller,
  core,
  demo,
  dialogs,
  files,
  hostTools,
  main,
  menu,
  misc,
  native,
  prefs,
  settings,
  shared,
  sidebar,
  telemetry,
  update,
  workbench,
} as const;
