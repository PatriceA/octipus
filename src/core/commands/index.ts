// Import command modules to register them
import './help';
import './status';
import './stop';
import './clear';
import './experts';
import './model';
import './models';
import './plan';
import './plan-mode-command';
import './eval';
import './cost';
import './capture';
import './docs';

export { getAllCommands, getCommand, handleCommand } from './registry';
