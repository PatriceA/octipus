/** Runs inside the target page. Keep self-contained: credentials are arguments, never source text. */
export function fillLoginFields(input:{origin:string;usernameSelector:string;passwordSelector:string;username:string;password:string}):boolean {
  if(location.origin!==input.origin)return false;
  const users=document.querySelectorAll(input.usernameSelector);
  const passwords=document.querySelectorAll(input.passwordSelector);
  if(users.length!==1||passwords.length!==1)return false;
  const user=users[0],password=passwords[0];
  if(!(user instanceof HTMLInputElement)||!(password instanceof HTMLInputElement)||user===password)return false;
  if(!['text','email','tel'].includes(user.type)||password.type!=='password')return false;
  if([user,password].some(el=>el.disabled||el.readOnly||!el.getClientRects().length))return false;
  if(user.form!==password.form)return false;
  if(user.form&&new URL(user.form.action,location.href).origin!==input.origin)return false;
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
  if(!setter)return false;
  setter.call(user,input.username);setter.call(password,input.password);
  for(const el of [user,password]){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  return true;
}
