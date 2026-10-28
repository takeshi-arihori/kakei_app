"""招待コードの独立参照計算。Production TypeScriptを読まず、合成値だけを使用する。"""
import hashlib, hmac, json, struct
from pathlib import Path

def tlv(values):
    return b''.join(bytes([i, 0 if v is None else 1]) + struct.pack('>I', len(c)) + c for i, v in enumerate(values, 1) for c in [b'' if v is None else v if isinstance(v, bytes) else v.encode('utf-8')])

def mac(key, data):
    return hmac.new(key, data, hashlib.sha256).hexdigest()

code=bytes(range(32)); keys={p:bytes(range(start,start+32)) for p,start in [('lookup',0),('state',32),('audit',64),('proof',96)]}
purposes={'lookup':'auth-recipient-code-lookup/v1','state':'auth-recipient-code-state/v1','audit':'auth-audit-recipient-code/v1','proof':'gm-recipient-code-request/v1'}
row={'codeId':'10000000-0000-4000-8000-000000000001','recipientActorId':'10000000-0000-4000-8000-000000000002','recordVersion':1,'epoch':'10000000-0000-4000-8000-000000000003','createdAt':1700000000000,'expiresAt':1700000600000,'status':'issued','terminalAt':None,'lookupKeyVersion':'lookup-1','macKeyVersion':'state-1'}
lookup=tlv(['kakei_app',purposes['lookup'],code]); digest=bytes.fromhex(mac(keys['lookup'],lookup))
def state_tlv(r):
    return tlv(['kakei_app',purposes['state'],r['codeId'],r['recipientActorId'],str(r['recordVersion']),r['epoch'],r['lookupKeyVersion'],digest,str(r['createdAt']),str(r['expiresAt']),r['status'],None if r['terminalAt'] is None else str(r['terminalAt']),r['macKeyVersion']])
terminal={**row,'recordVersion':2,'status':'consumed','terminalAt':1700000000001}
audit=tlv(['kakei_app',purposes['audit'],row['codeId']]);proof=tlv(['kakei_app',purposes['proof'],code])
values={'lookup':lookup,'issued':state_tlv(row),'consumed':state_tlv(terminal),'audit':audit,'proof':proof}
key_for={'lookup':'lookup','issued':'state','consumed':'state','audit':'audit','proof':'proof'}
result={'reference':'Python stdlib hmac/hashlib/struct; TypeScript未参照の公開合成値','decodedCodeHex':code.hex(),'keyHex':{k:v.hex() for k,v in keys.items()},'row':row,'terminalRow':terminal,'lookupDigestHex':digest.hex(),'vectors':{k:{'tlvHex':v.hex(),'hmacHex':mac(keys[key_for[k]],v)} for k,v in values.items()}}
Path(__file__).with_name('recipient-code-golden-vectors.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
