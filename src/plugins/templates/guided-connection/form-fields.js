// Dependency-free UI fields. Values are text, never HTML; IDs stay out of labels.
(function () {
 let sequence = 0;
 window.OctipusFields = function (container, fields, values, changed) {
  container.textContent = '';
  let current = {...values};
  for (const field of fields) {
   const label = document.createElement('label');label.textContent = field.label;
   const input = document.createElement(field.options ? 'select' : 'input');
   input.id = 'octipus-field-' + ++sequence;label.htmlFor = input.id;
   if (field.options) {
    const empty = document.createElement('option');empty.value = '';empty.textContent = 'Choose…';input.append(empty);
    for (const option of field.options) {const node=document.createElement('option');node.value=typeof option==='string'?option:option.value;node.textContent=typeof option==='string'?option:option.label;input.append(node);}
    if (values[field.key] && !Array.from(input.options).some(o=>o.value===String(values[field.key]))) {const node=document.createElement('option');node.value=values[field.key];node.textContent=values[field.key]+' (saved)';input.append(node);}
   } else {input.type = field.type || 'text';}
   input.value = values[field.key] ?? '';input.required = !!field.required;
   input.addEventListener('input', () => {current={...current,[field.key]:input.value};changed(current);});
   const wrapper=document.createElement('div');wrapper.className='form-field';wrapper.append(label,input);if(field.help){const help=document.createElement('small');help.textContent=field.help;wrapper.append(help);}container.append(wrapper);
  }
 };
}());
