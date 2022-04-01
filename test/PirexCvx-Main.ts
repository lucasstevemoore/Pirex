import { expect } from 'chai';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumber } from 'ethers';
import { every } from 'lodash';
import {
  callAndReturnEvents,
  toBN,
  increaseBlockTimestamp,
  validateEvent,
  randomNumberBetweenRange,
} from './helpers';
import {
  ConvexToken,
  CvxLocker,
  PirexCvx,
  PirexFees,
  UnionPirexVault,
} from '../typechain-types';

// Tests the actual deposit flow (deposit, stake/unstake, redeem...)
describe('PirexCvx-Main', function () {
  let admin: SignerWithAddress;
  let notAdmin: SignerWithAddress;
  let pCvx: PirexCvx;
  let pirexFees: PirexFees;
  let unionPirex: UnionPirexVault;
  let cvx: ConvexToken;
  let cvxLocker: CvxLocker;

  let zeroAddress: string;
  let redemptionUnlockTime: number;
  let epochDuration: BigNumber;

  let futuresEnum: any;
  let feesEnum: any;
  let stakeExpiry: BigNumber;

  before(async function () {
    ({
      admin,
      notAdmin,
      pCvx,
      pirexFees,
      unionPirex,
      cvx,
      cvxLocker,
      zeroAddress,
      redemptionUnlockTime,
      epochDuration,
      futuresEnum,
      feesEnum,
    } = this);
  });

  describe('deposit', function () {
    it('Should revert if assets is zero', async function () {
      const invalidAssets = toBN(0);
      const receiver = admin.address;
      const shouldCompound = true;

      await expect(
        pCvx.deposit(invalidAssets, receiver, shouldCompound)
      ).to.be.revertedWith('ZeroAmount()');
    });

    it('Should revert if receiver is zero address', async function () {
      const assets = toBN(1e18);
      const invalidReceiver = zeroAddress;
      const shouldCompound = true;

      await expect(
        pCvx.deposit(assets, invalidReceiver, shouldCompound)
      ).to.be.revertedWith('ZeroAddress()');
    });

    it('Should revert if sender asset balance is insufficient', async function () {
      const cvxBalance = await cvx.balanceOf(admin.address);
      const invalidAssets = cvxBalance.add(1);
      const receiver = admin.address;
      const shouldCompound = true;

      await expect(
        pCvx.deposit(invalidAssets, receiver, shouldCompound)
      ).to.be.revertedWith('ERC20: transfer amount exceeds balance');
    });

    it('should revert if the contract is paused', async function () {
      const cvxBalance = await cvx.balanceOf(admin.address);
      const receiver = admin.address;
      const shouldCompound = true;

      await pCvx.setPauseState(true);

      await expect(
        pCvx.deposit(cvxBalance, receiver, shouldCompound)
      ).to.be.revertedWith('Pausable: paused');

      await pCvx.setPauseState(false);
    });

    it('Should deposit CVX', async function () {
      const cvxBalanceBefore = await cvx.balanceOf(admin.address);
      const lockedBalanceBefore = await cvxLocker.lockedBalanceOf(pCvx.address);
      const unionTotalAssetsBefore = await unionPirex.totalAssets();
      const pCvxBalanceBefore = await unionPirex.balanceOf(admin.address);
      const assets = toBN(10e18);
      const receiver = admin.address;
      const shouldCompound = true;

      // Necessary since pCVX transfers CVX to itself before locking
      await cvx.approve(pCvx.address, assets);

      const events = await callAndReturnEvents(pCvx.deposit, [
        assets,
        receiver,
        shouldCompound,
      ]);
      const pCvxMintEvent = events[0];
      const depositEvent = events[1];
      const approvalEvent = events[2];
      const pCvxTransferApprovalEvent = events[3];
      const pCvxTransferEvent = events[4];
      const vaultMintEvent = events[5];
      const cvxTransferEvent = events[7];
      const cvxBalanceAfter = await cvx.balanceOf(admin.address);
      const lockedBalanceAfter = await cvxLocker.lockedBalanceOf(pCvx.address);
      const unionTotalAssetsAfter = await unionPirex.totalAssets();
      const pCvxBalanceAfter = await unionPirex.balanceOf(admin.address);

      expect(cvxBalanceAfter).to.equal(cvxBalanceBefore.sub(assets));
      expect(lockedBalanceAfter).to.equal(lockedBalanceBefore.add(assets));
      expect(pCvxBalanceAfter).to.equal(pCvxBalanceBefore.add(assets));
      expect(unionTotalAssetsAfter).to.equal(
        unionTotalAssetsBefore.add(assets)
      );
      validateEvent(pCvxMintEvent, 'Transfer(address,address,uint256)', {
        from: zeroAddress,
        to: pCvx.address,
        value: assets,
      });

      validateEvent(depositEvent, 'Deposit(uint256,address,bool)', {
        assets,
        receiver,
      });

      validateEvent(approvalEvent, 'Approval(address,address,uint256)', {
        owner: pCvx.address,
        spender: unionPirex.address,
        value: assets,
      });

      validateEvent(
        pCvxTransferApprovalEvent,
        'Approval(address,address,uint256)',
        {
          owner: pCvx.address,
          spender: unionPirex.address,
          value: 0,
        }
      );

      validateEvent(pCvxTransferEvent, 'Transfer(address,address,uint256)', {
        from: pCvx.address,
        to: unionPirex.address,
        value: assets,
      });

      validateEvent(vaultMintEvent, 'Transfer(address,address,uint256)', {
        from: zeroAddress,
        to: admin.address,
        value: assets,
      });

      validateEvent(cvxTransferEvent, 'Transfer(address,address,uint256)', {
        from: admin.address,
        to: pCvx.address,
        value: assets,
      });
    });
  });

  describe('initiateRedemption', function () {
    it('Should revert if lockIndex is out of bounds', async function () {
      const { lockData } = await cvxLocker.lockedBalances(pCvx.address);
      const invalidLockIndex = lockData.length + 1;
      const f = futuresEnum.reward;
      const assets = toBN(1e18);
      const receiver = admin.address;

      await expect(
        pCvx.initiateRedemption(invalidLockIndex, f, assets, receiver)
      ).to.be.revertedWith(
        'reverted with panic code 0x32 (Array accessed at an out-of-bounds or negative index)'
      );
    });

    it('Should revert if futures enum is out of range', async function () {
      const lockIndex = 0;
      const to = admin.address;
      const assets = toBN(1e18);
      const invalidF = futuresEnum.reward + 1;

      await expect(
        pCvx.initiateRedemption(lockIndex, invalidF, assets, to)
      ).to.be.revertedWith(
        'Transaction reverted: function was called with incorrect parameters'
      );
    });

    it('Should revert if assets is zero', async function () {
      const lockIndex = 0;
      const f = futuresEnum.reward;
      const invalidAssets = toBN(0);
      const receiver = admin.address;

      await expect(
        pCvx.initiateRedemption(lockIndex, f, invalidAssets, receiver)
      ).to.be.revertedWith('ZeroAmount()');
    });

    it('Should revert if receiver is zero address', async function () {
      const lockIndex = 0;
      const f = futuresEnum.reward;
      const assets = toBN(1);
      const invalidReceiver = zeroAddress;

      await expect(
        pCvx.initiateRedemption(lockIndex, f, assets, invalidReceiver)
      ).to.be.revertedWith('ZeroAddress()');
    });

    it('Should revert if redemption exceeds amount of CVX being unlocked', async function () {
      await increaseBlockTimestamp(Number(epochDuration));

      const assets = toBN(1e18);

      await cvx.approve(pCvx.address, assets);
      await pCvx.deposit(assets, admin.address, true);

      const { lockData } = await cvxLocker.lockedBalances(pCvx.address);
      const lockIndex = 1;
      const f = futuresEnum.reward;
      const invalidAssets = lockData[lockIndex].amount.add(toBN(1e18));
      const receiver = admin.address;

      expect(lockData[lockIndex].amount.lt(invalidAssets)).is.true;
      await expect(
        pCvx.initiateRedemption(lockIndex, f, invalidAssets, receiver)
      ).to.be.revertedWith('InsufficientRedemptionAllowance()');
    });

    it('Should revert if pCvx balance is insufficient', async function () {
      const pCvxBalance = await pCvx.balanceOf(notAdmin.address);
      const lockIndex = 0;
      const f = futuresEnum.reward;
      const invalidAssets = pCvxBalance.add(1);
      const receiver = admin.address;

      expect(pCvxBalance.lt(invalidAssets)).to.equal(true);
      await expect(
        pCvx
          .connect(notAdmin)
          .initiateRedemption(lockIndex, f, invalidAssets, receiver)
      ).to.be.revertedWith('ERC20: burn amount exceeds balance');
    });

    it('should revert if the contract is paused', async function () {
      const pCvxBalance = await pCvx.balanceOf(notAdmin.address);
      const lockIndex = 0;
      const f = futuresEnum.reward;
      const receiver = admin.address;

      await pCvx.setPauseState(true);

      await expect(
        pCvx.initiateRedemption(lockIndex, f, pCvxBalance, receiver)
      ).to.be.revertedWith('Pausable: paused');

      await pCvx.setPauseState(false);
    });

    it('Should initiate a redemption', async function () {
      const { timestamp } = await ethers.provider.getBlock('latest');
      const { lockData } = await cvxLocker.lockedBalances(pCvx.address);
      const lockIndex = 0;
      const { unlockTime } = lockData[lockIndex];

      redemptionUnlockTime = unlockTime;

      // Increase timestamp between now and unlock time to test futures notes correctness
      await increaseBlockTimestamp(
        randomNumberBetweenRange(0, Number(toBN(unlockTime).sub(timestamp)))
      );

      const { timestamp: timestampAfter } = await ethers.provider.getBlock(
        'latest'
      );
      const upCvx = await this.getUpCvx(await pCvx.upCvx());
      const currentEpoch = await pCvx.getCurrentEpoch();
      const pCvxBalanceBefore = await unionPirex.balanceOf(admin.address);
      const outstandingRedemptionsBefore = await pCvx.outstandingRedemptions();
      const upCvxBalanceBefore = await upCvx.balanceOf(
        admin.address,
        unlockTime
      );
      const msgSender = admin.address;
      const assets = toBN(1e18);
      const receiver = admin.address;

      await unionPirex.redeem(assets, msgSender, msgSender);

      const f = futuresEnum.reward;
      const events = await callAndReturnEvents(pCvx.initiateRedemption, [
        lockIndex,
        f,
        assets,
        receiver,
      ]);
      const burnEvent = events[0];
      const approvalEvent = events[1];
      const initiateEvent = events[2];
      const treasuryFeeTransferEvent = events[5];
      const contributorsFeeTransferEvent = events[7];
      const mintFuturesEvent = events[9];
      const pCvxBalanceAfter = await unionPirex.balanceOf(admin.address);
      const outstandingRedemptionsAfter = await pCvx.outstandingRedemptions();
      const upCvxBalanceAfter = await upCvx.balanceOf(
        admin.address,
        unlockTime
      );
      const remainingTime = toBN(unlockTime).sub(timestampAfter);
      const feeMin = toBN(await pCvx.fees(feesEnum.redemptionMin));
      const feeMax = toBN(await pCvx.fees(feesEnum.redemptionMax));
      const maxRedemptionTime = await pCvx.MAX_REDEMPTION_TIME();
      const feeDenominator = await pCvx.FEE_DENOMINATOR();
      const feePercent = feeMax.sub(
        feeMax.sub(feeMin).mul(remainingTime).div(maxRedemptionTime)
      );
      const feeAmount = assets.mul(feePercent).div(feeDenominator);
      const postFeeAmount = assets.sub(feeAmount);
      let expectedRewardsRounds = remainingTime.div(epochDuration);

      if (
        !toBN(unlockTime).mod(epochDuration).isZero() &&
        remainingTime.lt(epochDuration) &&
        remainingTime.gt(epochDuration.div(2))
      ) {
        expectedRewardsRounds = expectedRewardsRounds.add(1);
      }

      const rpCvxBalances = await this.getFuturesCvxBalances(
        Number(expectedRewardsRounds),
        futuresEnum.reward,
        currentEpoch
      );

      expect(pCvxBalanceAfter).to.equal(pCvxBalanceBefore.sub(assets));
      expect(outstandingRedemptionsAfter).to.equal(
        outstandingRedemptionsBefore.add(postFeeAmount)
      );
      expect(upCvxBalanceAfter).to.equal(upCvxBalanceBefore.add(postFeeAmount));
      validateEvent(burnEvent, 'Transfer(address,address,uint256)', {
        from: msgSender,
        to: zeroAddress,
        value: postFeeAmount,
      });
      expect(burnEvent.args.from).to.not.equal(zeroAddress);
      validateEvent(approvalEvent, 'Approval(address,address,uint256)', {
        owner: msgSender,
        spender: pirexFees.address,
        value: feeAmount,
      });
      expect(approvalEvent.args.owner).to.not.equal(zeroAddress);
      expect(approvalEvent.args.spender).to.not.equal(zeroAddress);
      expect(approvalEvent.args.value).to.not.equal(0);
      validateEvent(
        treasuryFeeTransferEvent,
        'Transfer(address,address,uint256)',
        {
          from: msgSender,
          to: await pirexFees.treasury(),
          value: feeAmount
            .mul(await pirexFees.treasuryPercent())
            .div(await pirexFees.PERCENT_DENOMINATOR()),
        }
      );
      expect(approvalEvent.args.from).to.not.equal(zeroAddress);
      expect(approvalEvent.args.to).to.not.equal(zeroAddress);
      expect(approvalEvent.args.value).to.not.equal(0);
      validateEvent(
        contributorsFeeTransferEvent,
        'Transfer(address,address,uint256)',
        {
          from: msgSender,
          to: await pirexFees.contributors(),
          value: feeAmount
            .mul(await pirexFees.contributorsPercent())
            .div(await pirexFees.PERCENT_DENOMINATOR()),
        }
      );
      expect(approvalEvent.args.from).to.not.equal(zeroAddress);
      expect(approvalEvent.args.to).to.not.equal(zeroAddress);
      expect(approvalEvent.args.value).to.not.equal(0);
      validateEvent(
        initiateEvent,
        'InitiateRedemption(address,uint256,address,uint256,uint256,uint256)',
        {
          sender: admin.address,
          assets,
          receiver,
          unlockTime,
          postFeeAmount,
          feeAmount,
        }
      );
      expect(initiateEvent.args.to).to.not.equal(zeroAddress);
      validateEvent(
        mintFuturesEvent,
        'MintFutures(uint8,uint8,uint256,address)',
        {
          rounds: expectedRewardsRounds,
          f,
          assets,
          receiver,
        }
      );
      expect(every(rpCvxBalances, (v) => v.eq(assets))).to.equal(true);
    });

    it('Should revert if insufficient redemption allowance', async function () {
      const { lockData } = await cvxLocker.lockedBalances(pCvx.address);
      const lockIndex = 1;
      const { unlockTime } = lockData[lockIndex];
      const redemptions = await pCvx.redemptions(unlockTime);
      const f = futuresEnum.reward;
      const invalidAssets = lockData[lockIndex].amount
        .sub(redemptions)
        .add(1)
        .mul(105)
        .div(100);
      const receiver = admin.address;

      await expect(
        pCvx.initiateRedemption(lockIndex, f, invalidAssets, receiver)
      ).to.be.revertedWith('InsufficientRedemptionAllowance()');
    });
  });

  describe('redeem', function () {
    it('Should revert if before lock expiry', async function () {
      const invalidUnlockTime = redemptionUnlockTime;
      const receiver = admin.address;
      const assets = toBN(1e18);

      await expect(
        pCvx.redeem(invalidUnlockTime, assets, receiver)
      ).to.be.revertedWith('BeforeUnlock()');
    });

    it('Should revert if assets is zero', async function () {
      const unlockTime = 0;
      const invalidAssets = 0;
      const receiver = admin.address;

      await expect(
        pCvx.redeem(unlockTime, invalidAssets, receiver)
      ).to.be.revertedWith('ZeroAmount()');
    });

    it('Should revert if receiver is zero address', async function () {
      const unlockTime = 0;
      const assets = 1;
      const invalidReceiver = zeroAddress;

      await expect(
        pCvx.redeem(unlockTime, assets, invalidReceiver)
      ).to.be.revertedWith('ZeroAddress()');
    });

    it('Should revert if insufficient upCVX balance for epoch', async function () {
      // Does not exist, should not have a valid token balance
      const invalidUnlockTime = toBN(redemptionUnlockTime).add(1);
      const assets = toBN(1e18);
      const receiver = admin.address;
      const upCvx = await this.getUpCvx(await pCvx.upCvx());
      const upCvxBalance = await upCvx.balanceOf(
        admin.address,
        invalidUnlockTime
      );
      const { timestamp } = await ethers.provider.getBlock('latest');

      await upCvx.setApprovalForAll(pCvx.address, true);
      await increaseBlockTimestamp(Number(invalidUnlockTime.sub(timestamp)));

      expect(upCvxBalance).to.equal(0);
      await expect(
        pCvx.redeem(invalidUnlockTime, assets, receiver)
      ).to.be.revertedWith(
        // Caused by ERC1155Supply _beforeTokenTransfer hook
        'reverted with panic code 0x11 (Arithmetic operation underflowed or overflowed outside of an unchecked block)'
      );
    });

    it('should revert if the contract is paused', async function () {
      const assets = toBN(1e18);
      const receiver = admin.address;

      await pCvx.setPauseState(true);

      await expect(
        pCvx.redeem(redemptionUnlockTime, assets, receiver)
      ).to.be.revertedWith('Pausable: paused');

      await pCvx.setPauseState(false);
    });

    it('Should redeem CVX', async function () {
      const upCvx = await this.getUpCvx(await pCvx.upCvx());
      const upCvxBalanceBefore = await upCvx.balanceOf(
        admin.address,
        redemptionUnlockTime
      );
      const { unlockable: unlockableBefore, locked: lockedBefore } =
        await cvxLocker.lockedBalances(pCvx.address);
      const outstandingRedemptionsBefore = await pCvx.outstandingRedemptions();
      const upCvxTotalSupplyBefore = await upCvx.totalSupply(
        redemptionUnlockTime
      );
      const cvxBalanceBefore = await cvx.balanceOf(admin.address);
      const assets = upCvxBalanceBefore.div(2);
      const receiver = admin.address;

      // Expected values post-relock and outstandingRedemptions decrementing
      const expectedRelock = unlockableBefore.sub(outstandingRedemptionsBefore);
      const expectedCvxOutstanding = outstandingRedemptionsBefore.sub(assets);
      const expectedPirexCvxBalance = outstandingRedemptionsBefore.sub(assets);
      const expectedLocked = lockedBefore.add(
        unlockableBefore.sub(outstandingRedemptionsBefore)
      );

      // Expected values post-burn
      const expectedUpCvxSupply = upCvxTotalSupplyBefore.sub(assets);
      const expectedUpCvxBalance = upCvxBalanceBefore.sub(assets);

      // Expected values post-CVX transfer
      const expectedCvxBalance = cvxBalanceBefore.add(assets);

      const events = await callAndReturnEvents(pCvx.redeem, [
        redemptionUnlockTime,
        assets,
        receiver,
      ]);
      const redeemEvent = events[0];
      const cvxTransferEvent = events[events.length - 1];
      const upCvxBalanceAfter = await upCvx.balanceOf(
        admin.address,
        redemptionUnlockTime
      );
      const { locked: lockedAfter } = await cvxLocker.lockedBalances(
        pCvx.address
      );
      const outstandingRedemptionsAfter = await pCvx.outstandingRedemptions();
      const upCvxTotalSupplyAfter = await upCvx.totalSupply(
        redemptionUnlockTime
      );
      const cvxBalanceAfter = await cvx.balanceOf(admin.address);
      const pirexCvxBalanceAfter = await cvx.balanceOf(pCvx.address);

      expect(expectedRelock).to.equal(lockedAfter.sub(lockedBefore));
      expect(expectedRelock).to.not.equal(0);
      expect(expectedCvxOutstanding).to.equal(outstandingRedemptionsAfter);
      expect(expectedCvxOutstanding).to.not.equal(0);
      expect(expectedPirexCvxBalance).to.equal(pirexCvxBalanceAfter);
      expect(expectedLocked).to.equal(lockedAfter);
      expect(expectedLocked).to.not.equal(0);
      expect(expectedUpCvxSupply).to.equal(upCvxTotalSupplyAfter);
      expect(expectedUpCvxSupply).to.not.equal(0);
      expect(expectedUpCvxBalance).to.equal(upCvxBalanceAfter);
      expect(expectedUpCvxBalance).to.not.equal(0);
      expect(expectedCvxBalance).to.equal(cvxBalanceAfter);
      expect(expectedCvxBalance).to.not.equal(0);
      validateEvent(redeemEvent, 'Redeem(uint256,uint256,address)', {
        epoch: redemptionUnlockTime,
        assets,
        receiver,
      });
      validateEvent(cvxTransferEvent, 'Transfer(address,address,uint256)', {
        from: pCvx.address,
        to: receiver,
        value: assets,
      });
    });
  });

  describe('stake', function () {
    it('Should revert if rounds is zero', async function () {
      const invalidRounds = 0;
      const f = futuresEnum.reward;
      const assets = toBN(1e18);
      const receiver = admin.address;

      await expect(
        pCvx.stake(invalidRounds, f, assets, receiver)
      ).to.be.revertedWith('ZeroAmount()');
    });

    it('Should revert if futures enum is out of range', async function () {
      const rounds = 1;
      const invalidF = futuresEnum.reward + 1;
      const assets = toBN(1e18);
      const receiver = admin.address;

      await expect(
        pCvx.stake(rounds, invalidF, assets, receiver)
      ).to.be.revertedWith(
        'Transaction reverted: function was called with incorrect parameters'
      );
    });

    it('Should revert if assets is zero', async function () {
      const rounds = 1;
      const f = futuresEnum.reward;
      const invalidAssets = 0;
      const receiver = admin.address;

      await expect(
        pCvx.stake(rounds, f, invalidAssets, receiver)
      ).to.be.revertedWith('ZeroAmount()');
    });

    it('Should revert if to is zero address', async function () {
      const rounds = 1;
      const f = futuresEnum.reward;
      const assets = toBN(1e18);
      const invalidReceiver = zeroAddress;

      await expect(
        pCvx.stake(rounds, f, assets, invalidReceiver)
      ).to.be.revertedWith('ZeroAddress()');
    });

    it('Should revert if pCVX balance is insufficient', async function () {
      const rounds = 1;
      const f = futuresEnum.reward;
      const assets = toBN(1e18);
      const receiver = admin.address;

      await pCvx.transfer(
        notAdmin.address,
        await pCvx.balanceOf(admin.address)
      );

      await expect(pCvx.stake(rounds, f, assets, receiver)).to.be.revertedWith(
        'ERC20: burn amount exceeds balance'
      );

      // Transfer funds back
      await pCvx
        .connect(notAdmin)
        .transfer(admin.address, await pCvx.balanceOf(notAdmin.address));
    });

    it('should revert if the contract is paused', async function () {
      const rounds = 1;
      const f = futuresEnum.reward;
      const assets = toBN(1e18);
      const receiver = admin.address;

      await pCvx.setPauseState(true);

      await expect(
        pCvx.stake(rounds, f, assets, receiver)
      ).to.be.revertedWith('Pausable: paused');

      await pCvx.setPauseState(false);
    });

    it('Should stake pCVX', async function () {
      const currentEpoch = await pCvx.getCurrentEpoch();
      const rounds = toBN(255);
      const f = futuresEnum.reward;
      const assets = toBN(1e18);
      const receiver = admin.address;
      const spCvx = await this.getSpCvx(await pCvx.spCvx());

      // Redeem pCVX from unionPirex vault
      await unionPirex.redeem(assets, admin.address, admin.address);

      const pCvxBalanceBefore = await pCvx.balanceOf(admin.address);

      // Expected values post-transfer
      const expectedPCvxBalance = pCvxBalanceBefore.sub(assets);

      // Expected values post-initialize
      const expectedStakeExpiry = currentEpoch.add(rounds.mul(epochDuration));

      // Store stake expiry for later testing
      stakeExpiry = expectedStakeExpiry;

      const spCvxBalanceBefore = await spCvx.balanceOf(
        receiver,
        expectedStakeExpiry
      );
      const events = await callAndReturnEvents(pCvx.stake, [
        rounds,
        f,
        assets,
        receiver,
      ]);
      const burnEvent = events[0];
      const stakeEvent = events[1];
      const mintFuturesEvent = events[3];
      const rpCvxBalances = await this.getFuturesCvxBalances(
        Number(rounds),
        f,
        currentEpoch
      );
      const spCvxBalanceAfter = await spCvx.balanceOf(
        receiver,
        expectedStakeExpiry
      );
      const pCvxBalanceAfter = await pCvx.balanceOf(admin.address);

      expect(expectedPCvxBalance).to.equal(pCvxBalanceAfter);
      expect(expectedStakeExpiry).to.not.equal(0);
      expect(spCvxBalanceAfter).to.equal(spCvxBalanceBefore.add(assets));
      validateEvent(burnEvent, 'Transfer(address,address,uint256)', {
        from: admin.address,
        to: zeroAddress,
        value: assets,
      });
      validateEvent(stakeEvent, 'Stake(uint8,uint8,uint256,address)', {
        rounds,
        f,
        assets,
        receiver,
      });
      validateEvent(
        mintFuturesEvent,
        'MintFutures(uint8,uint8,uint256,address)',
        {
          rounds,
          f,
          assets,
          receiver,
        }
      );
      expect(rpCvxBalances.length).to.equal(rounds);
      expect(every(rpCvxBalances, (r) => r.eq(assets))).to.equal(true);
    });
  });

  describe('unstake', function () {
    it('Should revert if id is less than timestamp', async function () {
      const { timestamp } = await ethers.provider.getBlock('latest');
      const invalidId = toBN(timestamp).add(10000);
      const assets = toBN(1e18);
      const receiver = admin.address;

      await expect(
        pCvx.unstake(invalidId, assets, receiver)
      ).to.be.revertedWith('BeforeStakingExpiry()');
    });

    it('Should revert if amount is zero', async function () {
      const id = 0;
      const invalidAssets = 0;
      const receiver = admin.address;

      await expect(
        pCvx.unstake(id, invalidAssets, receiver)
      ).to.be.revertedWith('ZeroAmount()');
    });

    it('Should revert if receiver is zero address', async function () {
      const id = 0;
      const assets = toBN(1e18);
      const invalidReceiver = zeroAddress;

      await expect(
        pCvx.unstake(id, assets, invalidReceiver)
      ).to.be.revertedWith('ZeroAddress()');
    });

    it('Should revert if spCVX balance is insufficient', async function () {
      const spCvx = await this.getSpCvx(await pCvx.spCvx());
      const { timestamp } = await ethers.provider.getBlock('latest');

      await increaseBlockTimestamp(Number(stakeExpiry.sub(timestamp)));

      const id = stakeExpiry;
      const receiver = admin.address;
      const spCvxBalance = await spCvx.balanceOf(admin.address, stakeExpiry);
      const emptyByteString = ethers.utils.solidityKeccak256(['string'], ['']);

      // Transfer funds to trigger insufficient balance error
      await spCvx.safeTransferFrom(
        admin.address,
        notAdmin.address,
        stakeExpiry,
        1,
        emptyByteString
      );

      const invalidAssets = spCvxBalance;

      // Approve burn
      await spCvx.setApprovalForAll(pCvx.address, true);

      await expect(
        pCvx.unstake(id, invalidAssets, receiver)
      ).to.be.revertedWith('ERC1155: burn amount exceeds balance');

      // Transfer funds back
      await spCvx
        .connect(notAdmin)
        .safeTransferFrom(
          notAdmin.address,
          admin.address,
          stakeExpiry,
          1,
          emptyByteString
        );
    });

    it('should revert if the contract is paused', async function () {
      const spCvx = await this.getSpCvx(await pCvx.spCvx());
      const id = stakeExpiry;
      const receiver = admin.address;
      const spCvxBalance = await spCvx.balanceOf(admin.address, stakeExpiry);

      await pCvx.setPauseState(true);

      await expect(
        pCvx.unstake(id, spCvxBalance, receiver)
      ).to.be.revertedWith('Pausable: paused');

      await pCvx.setPauseState(false);
    });

    it('Should unstake pCVX', async function () {
      const spCvx = await this.getSpCvx(await pCvx.spCvx());
      const id = stakeExpiry;
      const assets = await spCvx.balanceOf(admin.address, stakeExpiry);
      const receiver = admin.address;
      const pCvxBalanceBefore = await pCvx.balanceOf(receiver);
      const spCvxBalance = await spCvx.balanceOf(admin.address, stakeExpiry);

      // Expected pCVX balance post-unstake
      const expectedPCvxBalance = pCvxBalanceBefore.add(spCvxBalance);
      const expectedSpCvxBalance = spCvxBalance.sub(assets);

      const events = await callAndReturnEvents(pCvx.unstake, [
        id,
        assets,
        receiver,
      ]);
      const mintEvent = events[0];
      const unstakeEvent = events[1];
      const pCvxBalanceAfter = await pCvx.balanceOf(receiver);
      const spCvxBalanceAfter = await spCvx.balanceOf(
        admin.address,
        stakeExpiry
      );

      expect(expectedPCvxBalance).to.equal(pCvxBalanceAfter);
      expect(expectedPCvxBalance).to.not.equal(0);
      expect(expectedSpCvxBalance).to.equal(spCvxBalanceAfter);
      expect(expectedSpCvxBalance).to.equal(0);
      validateEvent(mintEvent, 'Transfer(address,address,uint256)', {
        from: zeroAddress,
        to: receiver,
        value: assets,
      });
      validateEvent(unstakeEvent, 'Unstake(uint256,uint256,address)', {
        id,
        assets,
        receiver,
      });
    });
  });
});