// Import command modules to register them
import './help';
import './status';
import './stop';
import './clear';
import './experts';
import './models';
import './plan';

export { handleCommand, getAllCommands, getCommand } from './registry';
