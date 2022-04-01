import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import {
  ConvexToken,
  CvxLocker,
  PirexCvx,
} from '../typechain-types';

// Tests the emergency relock mechanism on CvxLocker shutdown
describe('PirexCvx-Shutdown', function () {
  let notAdmin: SignerWithAddress;
  let pCvx: PirexCvx;
  let cvx: ConvexToken;
  let cvxLocker: CvxLocker;
  let cvxLockerNew: CvxLocker;
  let convexContractEnum: any;

  before(async function () {
    ({
      notAdmin,
      pCvx,
      cvx,
      cvxLocker,
      cvxLockerNew,
      convexContractEnum,
    } = this);
  });

  describe('unlock+relock', function () {
    it('Should revert if not called by owner', async function () {
      await expect(
        pCvx.connect(notAdmin).relock()
      ).to.be.revertedWith('Ownable: caller is not the owner');

      await expect(
        pCvx.connect(notAdmin).unlock()
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('Should relock any lockable CVX after the shutdown in CvxLocker', async function () {
      // Simulate shutdown in the old/current locker
      await cvxLocker.shutdown();

      // Withdraw all forced-unlocked CVX
      await pCvx.unlock();

      const cvxBalance = await cvx.balanceOf(pCvx.address);
      const outstandingRedemptions = await pCvx.outstandingRedemptions();

      // Set the new locker contract and set approval
      await pCvx.setConvexContract(convexContractEnum.cvxLocker, cvxLockerNew.address);

      // Attempt to relock with the new locker
      await pCvx.relock();

      // Confirm that the correct amount of Cvx are relocked
      const lockedBalanceAfter = await cvxLockerNew.lockedBalanceOf(pCvx.address);
      expect(lockedBalanceAfter).to.equal(cvxBalance.sub(outstandingRedemptions));
    });
  });
});
