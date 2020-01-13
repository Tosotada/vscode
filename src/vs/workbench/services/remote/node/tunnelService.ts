/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';
import { Barrier } from 'vs/base/common/async';
import { Disposable } from 'vs/base/common/lifecycle';
import { NodeSocket } from 'vs/base/parts/ipc/node/ipc.net';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import product from 'vs/platform/product/common/product';
import { connectRemoteAgentTunnel, IConnectionOptions } from 'vs/platform/remote/common/remoteAgentConnection';
import { IRemoteAuthorityResolverService } from 'vs/platform/remote/common/remoteAuthorityResolver';
import { ITunnelService, RemoteTunnel } from 'vs/platform/remote/common/tunnel';
import { nodeSocketFactory } from 'vs/platform/remote/node/nodeSocketFactory';
import { ISignService } from 'vs/platform/sign/common/sign';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { ILogService } from 'vs/platform/log/common/log';
import { findFreePort } from 'vs/base/node/ports';
import { AbstractTunnelService } from 'vs/workbench/services/remote/common/tunnelService';

export async function createRemoteTunnel(options: IConnectionOptions, tunnelRemoteHost: string, tunnelRemotePort: number, tunnelLocalPort?: number): Promise<RemoteTunnel> {
	const tunnel = new NodeRemoteTunnel(options, tunnelRemoteHost, tunnelRemotePort, tunnelLocalPort);
	return tunnel.waitForReady();
}

class NodeRemoteTunnel extends Disposable implements RemoteTunnel {

	public readonly tunnelRemotePort: number;
	public tunnelLocalPort!: number;
	public tunnelRemoteHost: string;
	public localAddress!: string;

	private readonly _options: IConnectionOptions;
	private readonly _server: net.Server;
	private readonly _barrier: Barrier;

	private readonly _listeningListener: () => void;
	private readonly _connectionListener: (socket: net.Socket) => void;

	constructor(options: IConnectionOptions, tunnelRemoteHost: string, tunnelRemotePort: number, private readonly suggestedLocalPort?: number) {
		super();
		this._options = options;
		this._server = net.createServer();
		this._barrier = new Barrier();

		this._listeningListener = () => this._barrier.open();
		this._server.on('listening', this._listeningListener);

		this._connectionListener = (socket) => this._onConnection(socket);
		this._server.on('connection', this._connectionListener);

		this.tunnelRemotePort = tunnelRemotePort;
		this.tunnelRemoteHost = tunnelRemoteHost;
	}

	public dispose(): void {
		super.dispose();
		this._server.removeListener('listening', this._listeningListener);
		this._server.removeListener('connection', this._connectionListener);
		this._server.close();
	}

	public async waitForReady(): Promise<this> {

		// try to get the same port number as the remote port number...
		const localPort = await findFreePort(this.suggestedLocalPort ?? this.tunnelRemotePort, 1, 1000);

		// if that fails, the method above returns 0, which works out fine below...
		const address = (<net.AddressInfo>this._server.listen(localPort).address());
		this.tunnelLocalPort = address.port;

		await this._barrier.wait();
		this.localAddress = 'localhost:' + address.port;
		return this;
	}

	private async _onConnection(localSocket: net.Socket): Promise<void> {
		// pause reading on the socket until we have a chance to forward its data
		localSocket.pause();

		const protocol = await connectRemoteAgentTunnel(this._options, this.tunnelRemotePort);
		const remoteSocket = (<NodeSocket>protocol.getSocket()).socket;
		const dataChunk = protocol.readEntireBuffer();
		protocol.dispose();

		if (dataChunk.byteLength > 0) {
			localSocket.write(dataChunk.buffer);
		}

		localSocket.on('end', () => remoteSocket.end());
		localSocket.on('close', () => remoteSocket.end());
		remoteSocket.on('end', () => localSocket.end());
		remoteSocket.on('close', () => localSocket.end());

		localSocket.pipe(remoteSocket);
		remoteSocket.pipe(localSocket);
	}
}

export class TunnelService extends AbstractTunnelService {
	public constructor(
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@ILogService logService: ILogService,
		@IRemoteAuthorityResolverService private readonly remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@ISignService private readonly signService: ISignService,
	) {
		super(environmentService, logService);
	}

	protected retainOrCreateTunnel(remoteAuthority: string, remoteHost: string, remotePort: number, localPort?: number): Promise<RemoteTunnel> | undefined {
		const portMap = this._tunnels.get(remoteHost);
		const existing = portMap ? portMap.get(remotePort) : undefined;
		if (existing) {
			++existing.refcount;
			return existing.value;
		}

		if (this._tunnelProvider) {
			const tunnel = this._tunnelProvider.forwardPort({ remoteAddress: { host: remoteHost, port: remotePort } });
			if (tunnel) {
				this.addTunnelToMap(remoteHost, remotePort, tunnel);
			}
			return tunnel;
		} else {
			const options: IConnectionOptions = {
				commit: product.commit,
				socketFactory: nodeSocketFactory,
				addressProvider: {
					getAddress: async () => {
						const { authority } = await this.remoteAuthorityResolverService.resolveAuthority(remoteAuthority);
						return { host: authority.host, port: authority.port };
					}
				},
				signService: this.signService,
				logService: this.logService
			};

			const tunnel = createRemoteTunnel(options, remoteHost, remotePort, localPort);
			this.addTunnelToMap(remoteHost, remotePort, tunnel);
			return tunnel;
		}
	}
}

registerSingleton(ITunnelService, TunnelService, true);
