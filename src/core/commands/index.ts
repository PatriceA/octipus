// Import command modules to register them
import './help';
import './status';
import './stop';
import './clear';
import './experts';
import './models';
import './plan';
import './eval';
import './cost';

export { getAllCommands, getCommand, handleCommand } from './registry';
