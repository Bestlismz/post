export function groupCommandKeyConfig(env=process.env,{optional=false}={}) {
  const keyId=env.GROUP_COMMAND_KEY_ID,raw=env.GROUP_COMMAND_KEYS;
  if(optional&&!keyId&&!raw)return null;
  try {
    if(typeof keyId!=='string'||!keyId||keyId.length>100||typeof raw!=='string')throw new Error();
    const encoded=JSON.parse(raw);
    if(!encoded||typeof encoded!=='object'||Array.isArray(encoded)||!Object.hasOwn(encoded,keyId))throw new Error();
    const keys={};
    for(const [id,value] of Object.entries(encoded)) {
      if(!id||id.length>100||typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/u.test(value))throw new Error();
      const decoded=Buffer.from(value,'base64');
      if(decoded.length!==32||decoded.toString('base64')!==value)throw new Error();
      keys[id]=decoded;
    }
    return {keyId,key:keys[keyId],keys};
  } catch {throw new Error('Invalid Group command signing configuration');}
}
