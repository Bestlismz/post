import http from 'node:http';

// Test-only bounded HTTP server. The adapter rewrites only the official Meta
// origin; production endpoint validation stays unchanged.
export async function startFakeMetaProvider() {
  const sends=[];let mode='automatic';
  const server=http.createServer(async(req,res)=>{
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>16384){res.writeHead(413).end();return;}chunks.push(chunk);}
    if(req.method!=='POST' || !/^\/v24\.0\/page\/messages$/.test(req.url)){res.writeHead(404).end();return;}
    const body=JSON.parse(Buffer.concat(chunks));sends.push(body);
    res.setHeader('Content-Type','application/json');
    if(mode==='rejected')res.writeHead(400).end(JSON.stringify({error:{code:100,message:'private provider rejection'}}));
    else if(mode==='uncertain')res.writeHead(500).end(JSON.stringify({error:{code:1}}));
    else res.end(JSON.stringify({message_id:`fake-meta-${sends.length}`,recipient_id:body.recipient.id}));
  });
  server.requestTimeout=2000;server.headersTimeout=2000;
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  return {sends,setMode(value){mode=value;},fetch(url,options){
    const target=new URL(url);if(target.origin!=='https://graph.facebook.com')throw Error('Unexpected fake-provider target');
    return fetch(origin+target.pathname,options);
  },async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
