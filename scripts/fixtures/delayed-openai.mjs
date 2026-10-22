// Mounted read-only by the container lifecycle test; never copied into the image.
const fields=Object.fromEntries(['budgetMin','budgetMax','bedrooms','moveInDate','requiredPetPolicy','district'].map(k=>[k,{status:'missing',value:null,evidence:[]}]));
globalThis.fetch=async(url,init)=>{
  if(String(url)!=='https://api.openai.com/v1/responses')throw Error('External network disabled in lifecycle test');
  const request=JSON.parse(init.body);
  const extracting=request.text.format.name==='rental_requirements';
  if(extracting){process.stdout.write('DELAYED_PROVIDER_ENTERED\n');await new Promise(resolve=>setTimeout(resolve,11000));}
  const answer=extracting?fields:{units:[],templateId:'clarify'};
  return Response.json({id:'resp_fake',object:'response',created_at:0,status:'completed',error:null,incomplete_details:null,
    model:request.model,output:[{id:'msg_fake',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:JSON.stringify(answer),annotations:[]}]}],
    parallel_tool_calls:false,tools:[],tool_choice:'auto',metadata:{}});
};
